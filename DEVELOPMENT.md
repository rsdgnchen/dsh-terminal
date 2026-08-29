# DEVELOPMENT — @yaha/dsh-terminal

面向开发者的内部文档：架构、文件职责、Host↔Client 协议、扩展点与踩坑。

## 1. 总体架构

DSH 插件 = 「Host 半（Node/Cordis，服务端）」+「Client 半（浏览器）」两个 bundle。本插件遵循 `@yaha/dsh-session-delete` 已验证的接入路径。

```
Browser (client.js)                           Server (index.js)
┌──────────────────────────────────────┐      ┌────────────────────────────────────────────┐
│ xterm.js panel (shell.overlay)       │      │ webServer: registerUpgrade                 │
│ - 1 tab = 1 xterm + 1 WebSocket      │ ───► │  /__yaha-terminal/ws                       │
│ - theme adaptation                   │ ◄─── │ - WebSocketServer(noServer)                │
│ - suspend / close state              │      │ - spawn 1 node-pty per connection          │
└──────────────────────────────────────┘      └────────────────────────────────────────────┘
```

> 说明：左＝浏览器半（`client.js`），右＝服务端半（`index.js`）。`───►`＝客户端经 WebSocket 上行（`input`/`resize`/`kill`），`◄───`＝Host 下行（`output`/`exit`/`error`）。客户端每个标签一条 WS → Host 为其起一个 `$SHELL` PTY；另有静态资源路由 `/__yaha-terminal/vendor/{xterm.js,xterm.css,addon-fit.js}` 与错误上报 `/__yaha-terminal/error`（POST）。

- **交互终端**：每标签页一个 WebSocket 连接 → Host 为其起一个 `$SHELL` 的 PTY，双向流式。
- **UI 挂载点**：注册进 `shell.overlay`（list 槽，additive），不替换任何现有内容。
- 不修改 DSH 核心（AppFrame / ConversationRoot），通过**测量 AppFrame 的 grid 列宽**实现「上8下2」压缩。

## 2. 文件职责

| 文件 | 角色 | 要点 |
|---|---|---|
| `package.json` | 插件清单 | `dsh.bundle.patch=./cordis.patch.yml`；`dsh.client.inject=['@deepseek-ai/dsh-client-runtime']`；`exports['./client']=./src/client.js`（浏览器 bundle 通过该 subpath 暴露） |
| `cordis.patch.yml` | bundle 层 | 向配置树 `insert` 一行 `{id: dsh-yaha-terminal, name: '@yaha/dsh-terminal'}` |
| `src/index.js` | Host | Cordis bundle 规则：named exports `apply/inject/name`。加载 node-pty、ws；注册 WS 升级路由 + 静态资源 + 错误日志路由 |
| `src/client.js` | 浏览器 | `window.__ModuleLoader__.load({id, factory})`；factory 接收 `require`，返回 `{apply, inject:['slots']}`；无 JSX，纯 `React.createElement` |
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

- `WebSocketServer({ noServer: true })` 由 `registerUpgrade` 处理 `/__yaha-terminal/ws` 的握手。
- 每个 `connection` → `spawnSession(ws)`：`pty.spawn(process.env.SHELL||'bash', ['-l'], {name:'xterm-256color', cols:80, rows:24, cwd: env.PWD||env.HOME||cwd, env:{...env, TERM:'xterm-256color', COLORTERM:'truecolor'}})`。
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
| `output` | `data:string` | PTY 输出增量 |
| `exit` | `exitCode, signal` | 顶层进程退出 |
| `error` | `message` | spawn 等失败 |

> 说明：客户端「标签页」通过**每个标签各开一条 WS** 实现（每标签独立会话）。挂起面板时 WS 保持打开（面板不卸载），因此输出不丢；关闭面板/标签时 WS 关闭 → Host 杀对应 PTY。

### 3.4 其它路由

- `/__yaha-terminal/vendor/{xterm.js,xterm.css,addon-fit.js}`：GET/HEAD，no-cache。
- `/__yaha-terminal/error`：POST，客户端上报运行时错误，追加到 `$YAHA_TERMINAL_ERROR_LOG`（默认 `os.tmpdir()/yaha-terminal-errors.log`），便于诊断。

## 4. Client 侧（src/client.js）

### 4.1 UI 挂载
- `apply(ctx)` 通过 `ctx.slots.inject('shell.overlay', () => ctx.slots.register({name:'shell.overlay', id:'yaha-terminal', order:40}, TerminalOverlay))` 注册一个 additive overlay entry。
- `inject: ['slots']`。

### 4.2 状态模型（TerminalOverlay 本地态）
面板用两个布尔区分「存在」与「可见」：

| 状态 | `mounted` | `shown` | 效果 |
|---|---|---|---|
| 打开 | true | true | 面板可见（停靠 `center` 列底部）；仅显示面板，底部入口横杠隐藏 |
| 挂起`−` | true | false | 面板 `display:none` 但**保留会话**；底部横杠＝恢复（品牌色点亮） |
| 关闭`×` | false | false | 卸载面板，杀死全部会话；底部横杠＝打开 |

- 压缩对话区：给 `center` 列设 `padding-bottom = (shown ? H : (handleVisible ? HANDLE_STRIP_H : 0))`（`useEffect` 依赖 `[shown, H, handleVisible]`）——终端展开时用面板高度 H；收起态**只在底部横杠 `visible` 时**预留 `HANDLE_STRIP_H`（14px）横条（不挡输出统计），横杠淡出后置 0，避免常驻压短对话滚动条、让滚动条底部缺像素。
- 底部入口是 `FloatOpenButton`：一根 **iOS 主屏指示条风格的半透明横杠**（`left=sidebar / right=details`，贴底部预留横条），**上滑**（或轻点/回车）**打开**终端；挂起态用品牌色点亮、普通态用次级文字色压暗。定位容器 `pointerEvents:none` 不拦截对话内容，只有横杠本体（156×14 触摸区）接收指针事件。为避免挡住 dsh 输出统计，**3 秒无操作自动淡出**（`opacity` + `pointerEvents:none`），光标靠近 frame 底部（`clientY ≥ rect.bottom - 56`）或与把手交互时重新亮起并重置计时；`visible` 经 `onVisibleChange` 上报给 `TerminalOverlay`，用于驱动上面的条件横条。
- **面板顶部小横杠（拖拽条）** = 拖动调高 + 点击收起：`onPointerDown` 里位移 `≤5px` 视为轻点，`onUp` 里未拖动则触发 `onMinimize()`（等同 `−`，保留会话）；超过 5px 才算拖动并 `onResize`。`title`/`aria-label` 提示「点击收起 · 拖动调整高度」。

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

### 4.7 会话结束自动关闭
- `TerminalView` 里 `handleEnded()`：收到 `{type:'exit'}` 或 WS `onclose` → 触发 `onExit(tabId)`（`onExitRef`）→ `TerminalPanel.handleExit(tabId)`。
- `handleExit`：移除该标签；若已是最后一个标签则关闭整个面板（`onClose`），否则切到相邻标签。**不写任何「已退出/关闭」驻留提示。**
- 注意用 `ended`/`disposed` 标志去重，避免 exit 与 onclose/卸载时重复触发。

## 5. 踩坑记录

1. **`t` 变量遮蔽（已踩过）**：`setTabs((t) => [...t, { title: t('title') ... }])` 里的 updater 形参 `t` 会遮蔽 i18n 的 `t()`，导致 `t('title')` 把**数组**当函数调用 → `TypeError: t is not a function`，整个 overlay entry 被错误边界摘掉（终端+按钮一起消失，需刷新）。**修复：updater 形参命名 `prev` 等，避免 `t`。** 所有回调里凡是要用 i18n `t()` 的，形参都不要叫 `t`。

2. **错误上报工具**：client 里有 `TerminalErrorBoundary`（class 组件）+ `window 'error'/'unhandledrejection'` → `fetch('/__yaha-terminal/error')`。排查 UI 组件消失类问题时，先看 Host 记录的 `<tmpdir>/yaha-terminal-errors.log`。

3. **隐藏标签不要用 `display:none`**：会让 xterm 容器塌成 0 尺寸；用 `visibility:hidden` 保尺寸。

4. **不要注册进 `root` / `conversation` 槽**：这两个是 single-occupant，注册会**替换**整个 AppFrame / 对话区。只能在 `shell.overlay`（list，additive）。

5. **会话生命周期**：面板 `×` 关闭会卸载面板 → 每条 WS 关闭 → Host 杀 PTY。若想更长时间保活，可考虑在 Host 按 `sessionId` 维护独立 PTY 并支持 attach/detach（当前未实现）。

## 6. 扩展点

- **改回看行数**：`client.js` `scrollback: 5000`。
- **换 shell / 启动参数**：`index.js` `spawnSession` 里的 `shell` / `['-l']` / `cwd`。
- **改字号 / 字体**：`client.js` `new window.Terminal({fontSize, fontFamily})`。
- **配置化**：可把颜色/高度/回看行数抽到 `cordis.patch.yml` 的配置树（当前为硬编码）。

## 7. 构建 / 部署流程（本地）

本插件以 `file:` 依赖被 profile 引用（`@yaha/dsh-terminal` → `file:$HOME/dsh/plugins/dsh-terminal`），profile 的 `node_modules/@yaha/dsh-terminal` 与源码**硬链接**（inode 相同），所以直接改 `$HOME/dsh/plugins/dsh-terminal/src/**` 即改到服务器加载的副本。

```bash
# 1) 若编辑器是「写临时文件再 rename 替换」，会断开硬链接——把改动重新放进 profile 副本：
cp -f $HOME/dsh/plugins/dsh-terminal/src/client.js \
      $HOME/.dsh/profiles/web/node_modules/@yaha/dsh-terminal/src/client.js

# 2) 若修改了 package.json / cordis.patch.yml / bundle 结构，需要重新 add：
dsh plugin --profile web add file:$HOME/dsh/plugins/dsh-terminal

# 3) 生效：
#    - 仅改 src/client.js：刷新浏览器即可（服务端 no-cache 现读 + dsh-client-hmr 常驻轮询拼 bundle）。
#    - 改了 bundle 结构 / 包清单：需重启 web 服务（客户端 bundle 在启动时重组）。
pm2 restart dsh-web
```

> 备注：`$HOME/.dsh/plugins/dsh-terminal` 是另一份**独立副本**（历史部署位置），当前 profile 并不引用它；只有 `file:` 指向的 `$HOME/dsh/plugins/dsh-terminal` 才是生效源码，二选一改动时保持同步即可。

## License

MIT
