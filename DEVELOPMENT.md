# DEVELOPMENT — @rsdgnchen/dsh-terminal

面向开发者的内部文档：架构、文件职责、Host↔Client 协议、扩展点与踩坑。

## 1. 总体架构

DSH 插件 = 「Host 半（Node/Cordis，服务端）」+「Client 半（浏览器）」两个 bundle。本插件遵循 `@yaha/dsh-session-delete` 已验证的接入路径。

```
Browser (client.js)                           Server (index.js)
┌──────────────────────────────────────┐      ┌────────────────────────────────────────────┐
│ xterm.js panel (shell.overlay)       │      │ webServer: registerUpgrade                 │
│ - 1 tab = 1 xterm + 1 WebSocket      │ ───► │  /__rsdgnchen-terminal/ws                  │
│ - theme adaptation                   │ ◄─── │ - WebSocketServer(noServer)                │
│ - suspend / close state              │      │ - spawn 1 node-pty per connection          │
└──────────────────────────────────────┘      └────────────────────────────────────────────┘
```

> 说明：左＝浏览器半（`client.js`），右＝服务端半（`index.js`）。`───►`＝客户端经 WebSocket 上行（`input`/`resize`/`kill`），`◄───`＝Host 下行（`output`/`exit`/`error`）。客户端每个标签一条 WS → Host 为其起一个 `$SHELL` PTY；另有静态资源路由 `/__rsdgnchen-terminal/vendor/{xterm.js,xterm.css,addon-fit.js}` 与错误上报 `/__rsdgnchen-terminal/error`（POST）。

- **交互终端**：每标签页一个 WebSocket 连接 → Host 为其起一个 `$SHELL` 的 PTY，双向流式。
- **UI 挂载点**：注册进 `shell.overlay`（list 槽，additive），不替换任何现有内容。
- 不修改 DSH 核心（AppFrame / ConversationRoot），通过**测量 AppFrame 的 grid 列宽**实现「上8下2」压缩。

## 2. 文件职责

| 文件 | 角色 | 要点 |
|---|---|---|
| `package.json` | 插件清单 | `dsh.bundle.patch=./cordis.patch.yml`；`dsh.client.inject=['@deepseek-ai/dsh-client-runtime']`；`exports['./client']=./src/client.js`（浏览器 bundle 通过该 subpath 暴露） |
| `cordis.patch.yml` | bundle 层 | 向配置树 `insert` 一行 `{id: dsh-rsdgnchen-terminal, name: '@rsdgnchen/dsh-terminal'}` |
| `src/index.js` | Host | Cordis bundle 规则：named exports `apply/inject/name`。加载 node-pty、ws；注册 WS 升级路由（**含 Host/Origin + 登录态鉴权**）+ 静态资源 + 错误日志路由 |
| `src/client.js` | 浏览器 | `window.__ModuleLoader__.load({id, factory})`；factory 接收 `require`，返回 `{apply, inject:['slots']}`；无 JSX，纯 `React.createElement`。**每会话一套面板**（`keys`）+ 会话 cwd + 铺满高度 |
| `src/vendor/*` | 随插件分发 | xterm.js 5.5.0 UMD + `xterm.css` + `@xterm/addon-fit`，由 Host 以 no-cache 出流，客户端首次打开时按需加载 |

## 3. Host 侧（src/index.js）

### 3.1 运行时解析 node-pty / ws

插件不声明 `node-pty`/`ws` 为自身依赖，避免 pnpm 触发 node-pty 原生模块的 node-gyp 重新编译。运行时：

```js
function loadModule(moduleName) {
  try { return require(moduleName) }           // 若作为依赖安装，正常解析
  catch { return require(harnessModule(moduleName)) }  // 回退到 Harness 全局安装
}
// harnessModule: 由 process.execPath 推导 <version>/lib/node_modules/@deepseek-ai/dsh/node_modules/<mod>
```

`node-pty` 已被 dsh 依赖并在进程内加载，重复 require 同一文件无害。

### 3.2 WebSocket 会话

- `WebSocketServer({ noServer: true })` 由 `registerUpgrade` 处理 `/__rsdgnchen-terminal/ws` 的握手。
- 每个 `connection` → `spawnSession(ws, requestedCwd(req))`：`pty.spawn(process.env.SHELL||'bash', ['-l'], {name:'xterm-256color', cols:80, rows:24, cwd, env:{...env, TERM:'xterm-256color', COLORTERM:'truecolor'}})`。
- **起始目录 = 当前会话的工作目录**：客户端把当前会话的 cwd 作为 `?cwd=<encoded>` 查询串带上；`requestedCwd(req)` 用 `new URL(req.url, base).searchParams.get('cwd')` 取值，**只接受「绝对路径 + `realpathSync` 成功 + 是目录」**，否则返回 `undefined`（连同查询串缺失/畸形一起回退）。
- `resolveCwd(sessionCwd) = process.env.DSH_TERMINAL_CWD || sessionCwd || process.env.HOME || process.cwd()`：**显式配置 > 会话目录 > HOME > 进程 cwd**。设了 `DSH_TERMINAL_CWD` 就固定用它（部署级固定目录，压过会话目录）。
- **不要改回 `process.env.PWD`**：Host 半跑在常驻 web 服务里，`PWD` 与 `process.cwd()` 都是服务启动目录（pm2 的 `exec cwd`），不是用户此刻的目录；用它们会让终端默认目录随服务启动位置漂移。
- spawn 成功后立即下发 `{type:'ready', pid, cwd}`（`cwd` 是**真正生效**的目录，可能是回退值），供客户端显示标签提示。
- **会话与连接 1:1**：连接建立即起 shell，连接关闭/`kill` 即销毁；绝不跨连接共享。
- 输出 `term.onData` → `ws.send({type:'output', data})`（无 Host 侧输出上限，纯流式）。
- `term.onExit` → 发送 `{type:'exit', exitCode, signal}`。

### 3.3 消息协议（JSON）

client → server:

| type | 字段 | 说明 |
|---|---|---|
| `input` | `data:string` | 写入 PTY stdin |
| `resize` | `cols,rows` | 调整 PTY 尺寸 |
| `kill` | — | 杀掉该会话 |

server → client:

| type | 字段 | 说明 |
|---|---|---|
| `ready` | `pid, cwd` | 会话已起：进程号 + **真正生效的起始目录**（可能是回退值） |
| `output` | `data:string` | PTY 输出增量 |
| `exit` | `exitCode, signal` | 顶层进程退出 |
| `error` | `message` | spawn 等失败 |

> 说明：客户端「标签页」通过**每个标签各开一条 WS** 实现（每标签独立会话）。挂起面板时 WS 保持打开（面板不卸载），因此输出不丢；关闭面板/标签时 WS 关闭 → Host 杀对应 PTY。

### 3.4 upgrade 鉴权（安全，别删）

`webServer.registerUpgrade` **只按路径分发，不做任何鉴权**——落在原始 socket 上的请求谁都能连。因此 `registerUpgrade` 的 handler 第一件事是：

```js
const rejection = upgradeRejection(ctx, req)   // → 403 | 401 | undefined
if (rejection !== undefined) { rejectUpgrade(socket, rejection); return }
```

- 主路径复用 `ctx.get('connection').requestRejection(req)`（`@deepseek-ai/dsh-client-connection` 的**公开**方法）：先 Host/Origin 围栏（403，含 DNS rebinding），再浏览器登录态校验（401，签名 cookie）。
- `connection` 服务缺失时走**退化路径**：无 `host` 头 / `sec-fetch-site: cross-site` / `Origin.host !== Host` 一律 403；无 `Origin`（非浏览器客户端）放行。
- 为什么必须挡：WebSocket **不受 CORS 限制**，浏览器里任意页面都能对 `ws://127.0.0.1:<port>` 发起连接；而本插件的 PTY **不受 DSH 沙箱约束**，等于把宿主机 shell 交出去。`ssh -L` 也挡不住——发起方是浏览器本身。
- 为什么不会挡住正常使用：`isTrustedApiRequest` 对 **loopback 任意端口**都放行，鉴权 cookie 按 Host authority 签发，所以 `ssh -L 8080:127.0.0.1:3080` 这种场景照样通过。
- 副作用：**不带 cookie 的脚本直连会 401**（本仓库自测探针要带上 `?token=` 换来的 `dsh-auth-*` cookie）。

### 3.5 其它路由

- `/__rsdgnchen-terminal/vendor/{xterm.js,xterm.css,addon-fit.js}`：GET/HEAD，no-cache。**未鉴权**（纯公开前端资源，无敏感信息）。
- `/__rsdgnchen-terminal/error`：POST，客户端上报运行时错误，追加到 `$RSDGNCHEN_TERMINAL_ERROR_LOG`（默认 `os.tmpdir()/rsdgnchen-terminal-errors.log`），便于诊断。**未鉴权**（仅日志追加，风险低）。

## 4. Client 侧（src/client.js）

### 4.1 UI 挂载
- `apply(ctx)` 通过 `ctx.slots.inject('shell.overlay', () => ctx.slots.register({name:'shell.overlay', id:'rsdgnchen-terminal', order:40}, TerminalOverlay))` 注册一个 additive overlay entry。
- `inject: ['slots']`。

### 4.2 状态模型（TerminalOverlay 本地态）
面板用两个布尔区分「存在」与「可见」，另加一个 `keys` 表示**哪些会话有面板**（每会话一套标签）：

| 状态 | `mounted` | `shown` | 效果 |
|---|---|---|---|
| 打开 | true | true | 当前会话那套面板可见（停靠 `center` 列底部）；底部入口横杠隐藏 |
| 挂起`−` | true | false | 全部门板 `display:none` 但**保留会话**；底部横杠＝恢复（品牌色点亮） |
| 关闭`×` | false | false | 卸载全部门板，杀死全部会话（`keys` 一并清空）；底部横杠＝打开 |

- `keys`（会话 key 数组，追加式）：`TerminalOverlay` 渲染 `keys.map(key => <TerminalPanel key={key} hidden={!shown || key !== activeKey} .../>)`。**别套只是 `display:none`，组件仍挂载 → WS/PTY 都活着**，切回来原样恢复（输出继续累积）。
- `activeKey` 来自 `useSessionKey(sessionKey, subscribe)`：`sessionKey()` 读 `ctx.sessions.list.getSnapshot().current`；`subscribe()` 挂在 `list.subscribe` 上，会话一变就 `setState` → 换套。取不到服务时退化成常量 `NO_SESSION_KEY`（单面板，等同旧行为）。
- **自动补面板**：`mounted && shown` 期间切换会话 → 该会话若还没有面板就自动建一个（首个标签落在它的 cwd 里）。因此「面板开着切 N 个会话」会留下 N 个后台 shell，`×` 才一次性释放。
- **退出语义**：当前会话最后一个标签退出 → `onClose()` 关闭**整个**面板（连带其他会话的后台终端）。这样也避开了「退出后又被自动补面板重新拉起」的循环。
- 压缩对话区：给 `center` 列设 `padding-bottom = (shown ? H : HANDLE_STRIP_H)`（`useEffect` 依赖 `[shown, H]`）——终端展开时用面板高度 H；收起态**常驻**预留 `HANDLE_STRIP_H`（8px）横条（不挡输出统计），常驻预留**没有显隐跳动**（对比此前「显时预留/隐时置 0」的条件做法）。该横条会让对话滚动容器略微变矮，故把对话消息滚动条改为**只显示滑块、透明轨道**（`CONV_SCROLL_CSS`，施加于 `.Md3f7G_scroll, .wSkVaW_scrollBody`，二者为 dsh 当前构建的 module-scoped 哈希类名），底部空隙不再露出「轨道缺失」。**关键**：类选择器列表里的每个 `::-webkit-scrollbar-*` 选择器必须各自带上伪元素后缀（用 `CONV_SCROLL_PSEUDO` 逐个子选择器拼接），否则逗号会拆出「整段元素」选择器（如 `.Md3f7G_scroll{width:8px}`）把容器压成 8px 宽。
- 底部入口是 `FloatOpenButton`：一根 **iOS 主屏指示条风格的半透明横杠**（`left=sidebar / right=details`，位于底部预留横条内、离底边约 2px），**上滑**（或轻点/回车）**打开**终端；挂起态用品牌色点亮、普通态用次级文字色压暗。定位容器 `pointerEvents:none` 不拦截对话内容，只有横杠本体（156×5 触摸区）接收指针事件。为避免挡住 dsh 输出统计，**3 秒无操作自动淡出**（`opacity` + `pointerEvents:none`），光标靠近 frame 底部（`clientY ≥ rect.bottom - 56`）或与把手交互时重新亮起并重置计时。
- **面板顶部小横杠（拖拽条）** = 拖动调高 + 点击收起：`onPointerDown` 里位移 `≤5px` 视为轻点，`onUp` 里未拖动则触发 `onMinimize()`（等同 `−`，保留会话）；超过 5px 才算拖动并 `onResize`。`title`/`aria-label` 提示「点击收起 · 拖动调整高度」。
- **铺满 ⛶**：`maximized` 是**全局**态（不随会话变）。`toggleMaximize()` 把 `H` 设为 `getFrame().clientHeight - 2` 并记住 `restoreHRef = 上一次 H`；再点还原。`onResize`（拖拽条）里 `setMaximized(false)`——手动拖高度即退出铺满。图标是内联 SVG（向外/向内四角括号），不依赖字体字形。

### 4.3 布局测量
- `getOverlayLayer()` = `document.querySelector('[data-shell-overlay]')`；其 `.parentElement` 即 AppFrame。
- `parseGrid(frame)` 解析 `frame.style.gridTemplateColumns`（形如 `"280px minmax(0,1fr) 0px"`）得到 `{sidebar, details}`，用于把终端面板 `left=sidebar / right=details` 精确对齐 center 列。
- `getCenterCol(frame)` = `frame.children[1]`（DOM 顺序：sidebar, center, details, overlay, handles）。

### 4.4 明暗自适应
- `buildPalette()`：`dark = document.body.hasAttribute('data-ds-dark-theme')`；再用 `getComputedStyle(body).getPropertyValue('--dsw-*')` 读真实 token（`--dsw-alias-bg-base/label-primary/label-secondary/brand-primary/border-l2`），缺失用各自 fallback。
- `buildTermTheme(p)`：生成 xterm 的 `theme`（background/foreground/cursor/cursorAccent/selectionBackground + 16 色 ANSI，明暗各一套）。
- `useAppPalette()`：`MutationObserver` 监听 `body` 的 `data-ds-dark-theme` 与 `style` 变化，变了就重算并 setPalette；`useEffect([palette])` 里 `term.options.theme = buildTermTheme(palette)` 热更配色，不打断会话。

### 4.5 xterm 载入
- `loadXterm()` 是模块级 memo 的 Promise：插 `<link href=xterm.css>` + `<script src=xterm.js>` + `<script src=addon-fit.js>`，等 `window.Terminal` 出现后 resolve。多个标签复用同一 promise，只注入一次。
- 每标签 `TerminalView`：`new window.Terminal({... scrollback:5000, theme})` + `new window.FitAddon.FitAddon()` + `term.open(container)`。
- resize：容器 `ResizeObserver` + 切到该标签时 re-fit（`useEffect([active])` 里 `fit.fit(); term.focus()`，包 try/catch）。
- 失败的终端初始化整体包 try/catch，落到 `setStatus('error')`，不抛出到 React。

### 4.6 标签页
- 每标签 `{id, num, title}`：`id` 是**单调** React key（不复用）；`num`/`title` 编号**复用空闲最小正整数**（改 `nextNum(prev)`）。
- 多标签**叠放**：`position:absolute; inset:0`，活动页 `visibility:visible; z-index:1`，其余 `visibility:hidden; z-index:0`（**保留尺寸**，切回不丢失、不重排）。
- **双击重命名**：`editingId / editText` + `startEdit/commitEdit/cancelEdit`；双击标题变 `<input>`（`useEffect` 聚焦+全选），`Enter`/失焦保存（`commitEdit` 只改 `title`，不动 `num`），`Esc` 取消。

### 4.7 每标签的起始目录（会话 cwd）
- `currentSessionCwd(ctx)`：`ctx.get('sessions')`（`dsh-api-session-controller` 的 client 服务）→ `sessions.list.getSnapshot()` → 取 `snapshot.current` 会话记录里的 `cwd`（Host 下发的权威值，**与核心终端的「Session workspace」同源**）。兼容 `{ids,byId}` 与 `{items}` 两种快照形状；整段 try/catch，**取不到就返回 `undefined`**（Host 回退 `$HOME`）。
- **刻意不写进 `inject`**：用 `ctx.get()` 动态取服务，服务未就绪/缺失时插件照常挂载并回退，而不是整个 overlay 入口因依赖缺失而不注册。
- 数据流：`apply(ctx)` 里造一个稳定的 `getCwd` → `TerminalOverlay` 透传给 `TerminalPanel` → **首个标签的 `useState` 初始化器与 `addTab()`** 各读一次，把 cwd **冻结进该标签**（`{id,num,title,cwd}`）→ `TerminalView` 在创建 WS 时带上 `?cwd=...`。
- 语义：**创建时取一次**。切换会话不会搬走已在跑的 shell；新建标签 / 关掉面板重开会用那时的当前会话目录。
- `TerminalView` 收到 `{type:'ready'}` → `onReady(cwd)` → 写回 `tab.cwd`，标签悬停提示显示**实际生效**的目录（回退时也能看出来）。

### 4.8 会话结束自动关闭
- `TerminalView` 里 `handleEnded()`：收到 `{type:'exit'}` 或 WS `onclose` → 触发 `onExit(tabId)`（`onExitRef`）→ `TerminalPanel.handleExit(tabId)`。
- `handleExit`：移除该标签；若已是最后一个标签则关闭整个面板（`onClose`），否则切到相邻标签。**不写任何「已退出/关闭」驻留提示。**
- 注意用 `ended`/`disposed` 标志去重，避免 exit 与 onclose/卸载时重复触发。

### 4.9 键盘接管（默认无需开关）
- 目标：终端打开/切标签/挂起恢复时**自动聚焦**，让键盘以终端输入为准，避免 `Ctrl+C`/`Ctrl+U`/`Ctrl+A` 等被浏览器抢走（`Ctrl+W`/`Cmd+W` 属窗口级保留快捷键——见下方「限制」——Win/Linux 上焦点再准也拦不住 `Ctrl+W`，README 已把它从「可接管键」中划掉）。
- 实现：`TerminalView` 在**初始化完成后**（boot 建好 term 后 `if (active)` 用 `rAF` 聚焦一次）、**切到活动页**（`[active]` effect）、**尺寸变化/挂起恢复**（ResizeObserver）三处 `term.focus()`。方案 B：**默认接管、不设开关**。
- 释放/接管：无需代码——**点终端外面**自然 `blur`（键盘回浏览器），**点终端**或**重新打开/切换**即 `focus()` 接管。
- 曾考虑过「开关按钮/图钉/双击」等形式，因与终端极简表头风格冲突、且双击命中不稳定而放弃，改为默认接管。
- **限制**：`Ctrl+W`/`Cmd+W`（关标签页）、`Ctrl+T`、`Ctrl+L`、`F5/Ctrl+R`、`Ctrl+Shift+I` 等**窗口级**快捷键由浏览器 chrome 处理，**任何网页都无法拦截**（所有浏览器终端同理）——按键根本到不了 xterm，`attachCustomKeyEventHandler` 只能影响「能到达 xterm 的按键」，shell 侧 readline 绑定也无济于事。Win/Linux 上 `Ctrl+W` 被浏览器占用（关标签页），删前一词请用 `Ctrl+U` 或 `Alt+Backspace`；**macOS 浏览器保留的是 `Cmd+W`，`Ctrl+W` 可正常进终端**。

## 5. 踩坑记录

1. **`t` 变量遮蔽（已踩过）**：`setTabs((t) => [...t, { title: t('title') ... }])` 里的 updater 形参 `t` 会遮蔽 i18n 的 `t()`，导致 `t('title')` 把**数组**当函数调用 → `TypeError: t is not a function`，整个 overlay entry 被错误边界摘掉（终端+按钮一起消失，需刷新）。**修复：updater 形参命名 `prev` 等，避免 `t`。** 所有回调里凡是要用 i18n `t()` 的，形参都不要叫 `t`。

2. **错误上报工具**：client 里有 `TerminalErrorBoundary`（class 组件）+ `window 'error'/'unhandledrejection'` → `fetch('/__rsdgnchen-terminal/error')`。排查 UI 组件消失类问题时，先看 Host 记录的 `<tmpdir>/rsdgnchen-terminal-errors.log`。

3. **隐藏标签不要用 `display:none`**：会让 xterm 容器塌成 0 尺寸；用 `visibility:hidden` 保尺寸。

4. **不要注册进 `root` / `conversation` 槽**：这两个是 single-occupant，注册会**替换**整个 AppFrame / 对话区。只能在 `shell.overlay`（list，additive）。

5. **会话生命周期**：面板 `×` 关闭会卸载面板 → 每条 WS 关闭 → Host 杀 PTY。若想更长时间保活，可考虑在 Host 按 `sessionId` 维护独立 PTY 并支持 attach/detach（当前未实现）。

6. **CSS 逗号会把「伪元素」拆成「整段元素」选择器（已踩过，曾把整个页面布局搞崩）**：`.Md3f7G_scroll, .wSkVaW_scrollBody::-webkit-scrollbar{width:8px}` 会被逗号拆成「`.Md3f7G_scroll`（整段） **或** `.wSkVaW_scrollBody::-webkit-scrollbar`」，于是 `width:8px` 作用到**整个消息容器**，把它压成 8px 宽 → 每行单字母、页面走样。**修复：每个 `::-webkit-scrollbar-*` 选择器必须各自带上伪元素后缀，再用 `CONV_SCROLL_PSEUDO(p)` 逐个子选择器拼接**，不要用「`选择器列表 + '::-webkit-scrollbar'`」这种写法。

7. **`useState` 初始化器里不要读「还没执行到的 `useRef`/`const`」（已踩过）**：首个标签的 cwd 要在 `useState(() => [{..., cwd: readCwd()}])` 里现读，而 `readCwd()` 依赖 `const getCwdRef = useRef(getCwd)`。`const` 在 `useState` 之后声明时，初始化器执行期间 `getCwdRef` 仍在 **TDZ**，`ReferenceError` 被 `readCwd` 自己的 try/catch 吞掉 → **首个标签永远拿不到 cwd**（无报错、静默降级）。**修复：把 `useRef`/辅助函数声明在 `useState` 之前**；凡是「初始化器 + 静默 catch」的组合，都要用真实渲染（或 hook 顺序一致的测试）验证，别只看有没有抛错。

8. **隐藏的终端面板既不 `fit()` 也不 `focus()`（多面板后必须做）**：每会话一套面板后，非当前会话的面板是 `display:none` → 容器尺寸为 0。此时 `fit.fit()` 会算出 0 尺寸的 cols/rows 并通过 `term.onResize` **把错的 PTY 尺寸发回 Host**；`term.focus()` 还会**把键盘焦点从可见面板抢走**。**修复：所有 fit/focus 入口（`[active]` effect、`ResizeObserver`）先判 `el.clientWidth && el.clientHeight`**。注意别把 `ResizeObserver` 的守卫删掉：面板重新显示时尺寸恢复，正是靠它再次触发 re-fit。

## 6. 扩展点

- **改回看行数**：`client.js` `scrollback: 5000`。
- **换 shell / 启动参数**：`index.js` `spawnSession` 里的 `shell` / `['-l']` / `cwd`。
- **改字号 / 字体**：`client.js` `new window.Terminal({fontSize, fontFamily})`。
- **配置化**：可把颜色/高度/回看行数抽到 `cordis.patch.yml` 的配置树（当前为硬编码）。

## 7. 构建 / 部署流程（本地）

> **先看 `AGENT-CONTEXT.md`**：profile 现在以 `github:rsdgnchen/dsh-terminal` 安装，**源码目录 ≠ profile 实际加载的副本**（加载的是 `~/.dsh/profiles/web/node_modules/@rsdgnchen/dsh-terminal`，与 `$HOME/dsh/plugins/dsh-terminal` 是两份文件），**改源码不会自动生效**。

标准流程（走 GitHub）：

```bash
cd /home/yaha/dsh/plugins/dsh-terminal
git add -A && git commit -m "你的说明" && git push     # 先 git status 确认有改动，避免 nothing to commit 让 && 短路
cd ~/.dsh/profiles/web && pnpm update @rsdgnchen/dsh-terminal
pm2 restart dsh          # 本机 pm2 进程名是 dsh（脚本 /home/yaha/bin/dsh-web.sh）
```

不想走 GitHub（本地调试）时，直接把改动同步进 profile 副本更省事：

```bash
SRC=$HOME/dsh/plugins/dsh-terminal
DST=$HOME/.dsh/profiles/web/node_modules/@rsdgnchen/dsh-terminal
cp -f $SRC/src/index.js  $DST/src/index.js
cp -f $SRC/src/client.js $DST/src/client.js
pm2 restart dsh
```

> 改了 `package.json` / `cordis.patch.yml` / bundle 结构就不能只 `cp`，要用
> `dsh plugin --profile web add ...` 重装（或先切回 `file:` 本地源）。

生效范围：

- **只有 `src/client.js` 变**：刷新浏览器即可（服务端对 client bundle 是 no-cache 现读 + `dsh-client-hmr` 轮询）。
- **`src/index.js`（Host 半）或包清单变**：**必须重启 web 服务**（Host 插件在启动时装载，没有 HMR）。
- 校验服务端实际下发的是哪一份：见 `AGENT-CONTEXT.md` 末尾的 `sha256sum` / boot 页组合 URL 检查。

> `pm2 restart dsh` 会**中断正在进行的会话回合**（会话本身已持久化，可重新连接继续）。

## License

MIT
