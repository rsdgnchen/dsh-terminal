# DEVELOPMENT — @yaha/dsh-terminal

面向开发者的内部文档：架构、文件职责、Host↔Client 协议、扩展点与踩坑。

## 1. 总体架构

DSH 插件 = 「Host 半（Node/Cordis，服务端）」+「Client 半（浏览器）」两个 bundle。本插件遵循 `@yaha/dsh-session-delete` 已验证的接入路径。

```
浏览器 (client.js)                    服务端 (index.js)
┌──────────────────────────┐        ┌──────────────────────────────┐
│ xterm.js 面板（shell.overlay）│  WS   │ webServer: registerUpgrade     │
│  · 标签页(每标签一 xterm+WS) │ ────► │  /__yaha-terminal/ws           │
│  · 明暗自适应                │  ◄──  │  · WebSocketServer(noServer)   │
│  · 挂起/关闭 控制状态         │       │  · 每连接 spawn 一个 node-pty   │
└──────────────────────────┘        │  /__yaha-terminal/vendor/*       │
                                     │  /__yaha-terminal/error (POST)  │
                                     └──────────────────────────────┘
```

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
| 打开 | true | true | 面板可见；悬浮按钮隐藏 |
| 挂起`−` | true | false | 面板 `display:none` 但**保留会话**；悬浮按钮＝恢复（黄点） |
| 关闭`×` | false | false | 卸载面板，杀死全部会话 |

- 压缩对话区：`shown && center` 时给 `center` 列设 `padding-bottom = H`，否则清空（`useEffect` 依赖 `[shown, H]`）。

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

## 5. ⚠ 踩坑记录

1. **`t` 变量遮蔽（已踩过）**：`setTabs((t) => [...t, { title: t('title') ... }])` 里的 updater 形参 `t` 会遮蔽 i18n 的 `t()`，导致 `t('title')` 把**数组**当函数调用 → `TypeError: t is not a function`，整个 overlay entry 被错误边界摘掉（终端+按钮一起消失，需刷新）。**修复：updater 形参命名 `prev` 等，避免 `t`。** 所有回调里凡是要用 i18n `t()` 的，形参都不要叫 `t`。

2. **错误上报工具**：client 里有 `TerminalErrorBoundary`（class 组件）+ `window 'error'/'unhandledrejection'` → `fetch('/__yaha-terminal/error')`。排查 UI 组件消失类问题时，先看 Host 记录的 `/tmp/yaha-terminal-errors.log`。

3. **隐藏标签不要用 `display:none`**：会让 xterm 容器塌成 0 尺寸；用 `visibility:hidden` 保尺寸。

4. **不要注册进 `root` / `conversation` 槽**：这两个是 single-occupant，注册会**替换**整个 AppFrame / 对话区。只能在 `shell.overlay`（list，additive）。

5. **会话生命周期**：面板 `×` 关闭会卸载面板 → 每条 WS 关闭 → Host 杀 PTY。若想更长时间保活，可考虑在 Host 按 `sessionId` 维护独立 PTY 并支持 attach/detach（当前未实现）。

## 6. 扩展点

- **改回看行数**：`client.js` `scrollback: 5000`。
- **换 shell / 启动参数**：`index.js` `spawnSession` 里的 `shell` / `['-l']` / `cwd`。
- **改字号 / 字体**：`client.js` `new window.Terminal({fontSize, fontFamily})`。
- **配置化**：可把颜色/高度/回看行数抽到 `cordis.patch.yml` 的配置树（当前为硬编码）。

## 7. 构建 / 部署流程（本地）

```bash
# 1) 编辑源码后，同步到部署目录（服务器实际加载的位置）
cp -r /home/yaha/dsh/dsh-terminal/* /home/yaha/.dsh/plugins/dsh-terminal/

# 2) 若修改了 package.json / bundle 结构，需要重新 add：
dsh plugin --profile web add file:/home/yaha/.dsh/plugins/dsh-terminal

# 3) 生效（客户端 bundle 需在服务启动时重组）：
pm2 restart dsh-web
```

> 注意：`@yaha/dsh-session-delete` 在 profile 的 node_modules 是**独立副本**，编辑 `~/.dsh/plugins/...` 后需再同步到 `~/.dsh/profiles/web/node_modules/@yaha/dsh-session-delete/`；而 `@yaha/dsh-terminal` 在 profile 中是**硬链接**到 `~/.dsh/plugins/dsh-terminal/`（inode 相同），直接编辑插件源即可。

## License

MIT
