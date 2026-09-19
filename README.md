# @rsdgnchen/dsh-terminal

DeepSeek Harness Web 的**系统交互终端插件**：在页面右侧 8 列（对话区）内做上下 `8/2` 分区，上方 8 是对话，下方 2 是一个真实的系统 shell（node-pty 起 `$SHELL`，xterm.js 渲染）。底部用 **iOS 风格透明横杠**呼出终端；终端顶部的**小横杠**拖动可调高、**点击可收起**（等同 `−`）。

插件名带 `rsdgnchen`，便于你在 `~/.dsh/plugins/` 下统一管理。

```
┌───────────┬────────────────────────────────┐
│ Sidebar   │ Conversation                   │
│  (2)      │  Chat          (8/8)           │
│           ├────────────────────────────────┤
│           │  Terminal      (2/8)           │
│           │  [Terminal 1]  [+]  [-]  [x]   │
└───────────┴────────────────────────────────┘
```
（左列 = 侧栏（占宽 2/8）；右列 = 对话区（占宽 8/8）。对话区内做上下 8/2 分区：上 = 聊天会话，下 = 终端面板。）

## 特性

- **真实系统终端**：Host 侧用 `node-pty` 起 `$SHELL`（默认 `SHELL` 环境变量，如 zsh/bash），支持颜色、作业控制、交互式程序（vim / less / top 等）。
- **起始目录 = 当前会话的工作目录**：新终端默认开在**你此刻所在会话的 cwd**（即该会话 workspace，与核心终端同源）。每个标签在**创建那一刻**取一次当前会话的目录：之后切换会话**不会**搬走已在运行的 shell（shell 的 cwd 只能自己 `cd`），但**新建标签 / 关掉面板重新打开**都会用那时的当前会话目录。标签悬停提示里能看到该终端真正生效的起始目录。
  - 目录优先级：**`DSH_TERMINAL_CWD`（显式配置的固定目录）> 会话工作目录 > `$HOME` > 进程 cwd**。即设了 `DSH_TERMINAL_CWD` 就固定用它；没设才跟随会话；取不到会话目录（如服务未就绪、会话还没记录 cwd）才回退 `$HOME`。
  - **刻意不读 `PWD`/`process.cwd()`**：插件跑在常驻服务里（pm2 / systemd），这两个值都是「服务被启动那一刻」的目录，会随启动位置漂移（从 `~/bin` 起 pm2，终端就全开在 `~/bin`）。
  - 客户端只把「已存在的绝对目录」带给 Host；Host 再 `realpath` + 校验是目录，非法值一律忽略并回退。
- **上下 8/2 分区**：终端出现时，对话区高度真正被压缩（`center` 列加 `padding-bottom`），终端停靠在 `center` 列底部（不遮挡侧栏 / 详情列）。
- **每会话一套标签**：终端按**会话**隔离。切到别的会话时，面板换成**那个会话自己的**标签，并自动为该会话开一个终端（落在它的工作目录里）；原会话那套标签与 shell **不销毁**，仍在后台存活，切回去原样恢复（输出继续累积）。**只有关掉面板（`×`）才一次性结束全部会话。**
- **多终端标签页**：蓝色 `+` 新建标签，每个标签一个独立 shell 会话；切换标签**不销毁**会话（`visibility` 叠放，保持尺寸）。
- **一键铺满**：标题栏 ⛶ 把面板铺满整个对话列高度，再点一次还原到拖动前的高度；铺满状态下**手动拖动高度会自动退出铺满**（以你拖的为准）。
- **挂起 `−` / 关闭 `×`**：
  - `−`（挂起）：只隐藏面板，**保留全部会话与输出**；底部透明横杠用**品牌色点亮**（恢复态），上滑/轻点即可还原。
  - `×`（关闭）：真正卸载面板并杀死全部会话（含其他会话的后台终端）。
  - 顺序为软件惯例：**`− ×`**。
  - **顶部小横杠也能收起**：拖动它调整高度；**点击（未拖动）即收起终端**（等同 `−`，保留会话）。
- **标签可重命名**：**双击**标签标题即可内联改名，`Enter`/失焦保存、`Esc` 取消。
- **会话结束自动关闭**：按 `Ctrl+D`（或 `exit` / 连接断开）会直接关闭该标签；若是**当前会话的最后一个标签**则关闭整个面板，**不会驻留「已退出」提示**。
- **升级鉴权（安全）**：WS 端点会先过 DSH 的 **Host/Origin 围栏 + 浏览器登录态校验**（复用 `ctx.get('connection').requestRejection`），未通过直接 401/403 断开——「随便一个网页连上 `127.0.0.1:3080` 就能拿到 shell」这条路被堵死，`ssh -L` 转发到别的本地端口照常可用。
- **编号复用**：标签编号取「当前所有标签中最小的空闲正整数」，关掉后再新建会复用之前的编号（1、2、3 → 关掉 3 → 新建 = 3）。
- **明暗自适应**：xterm 与面板颜色跟随应用主题（识别 `<body data-ds-dark-theme>` 与 `--dsw-*` 语义 token），切换到系统浅色/深色会自动换配色。
- **拖拽调高**：终端顶部拖拽条可调高度（120–520px）。
- **输出回看**：xterm 滚动缓冲默认 **5000 行**（改 `src/client.js` 的 `scrollback`）
- **入口**：对话区底部有一根 **iOS App Switcher 样式的透明横杠**：**上滑**（或轻点/回车）**打开**终端。它**常驻预留一条 `HANDLE_STRIP_H`（8px）横条**，**不遮挡 dsh 输出统计**，且**常驻预留没有显隐跳动**；横杠离屏幕底边约 **2px**（iOS home-indicator 式）。横杠 3 秒无操作自动淡出（同滚动条逻辑），光标靠近底部时重新亮起。为掩盖「常驻横条让对话滚动容器略微变矮」的观感，对话消息滚动条改为**只显示滑块、透明轨道**（对齐 DeepSeek/Gemini）。**收起终端用面板顶部的小横杠**（拖动=调高、点击=收起），而不是这根入口横杠。头部不放终端按钮，保持简洁。
- **键盘接管（默认）**：终端打开/切换标签/挂起恢复时**自动聚焦**，把键盘交给终端（以终端输入为准，避免 `Ctrl+C`/`Ctrl+U`/`Ctrl+A` 等被浏览器抢走）。**无需开关**：想释放就**点终端外面**（键盘交还浏览器），想再接管就**点终端**或重新打开/切换。
- **已知限制（浏览器行为，不是 bug）**：`Ctrl+W`/`Cmd+W`（关标签页）、`Ctrl+T`、`Ctrl+L`、`F5/Ctrl+R`、`Ctrl+Shift+I` 等**窗口级**快捷键由浏览器 chrome 处理，**任何网页都无法拦截**——本插件、xterm.js、VS Code Web、Secure Shell 等一切浏览器终端都一样。按下 `Ctrl+W` 会直接关掉浏览器标签页，按键根本到不了终端，shell 侧的 readline 绑定也无济于事。
- **「删前一个词」**：Windows/Linux 上 `Ctrl+W` 被浏览器占用（关标签页），可改用 `Ctrl+U`（删整行）或 `Alt+Backspace`（backward-kill-word）；**macOS 不受此影响**——macOS 浏览器保留的是 `Cmd+W`，`Ctrl+W` 能正常进入终端。

## 安装

> 前置条件：**需先安装 pnpm，并确保在 `PATH` 上**。`dsh plugin` 会把参数转发给 `pnpm`（在 profile 目录里管理依赖），没有 pnpm 会报 `dsh: pnpm not found on PATH`。
> 安装 pnpm（任选其一）：
> ```bash
> corepack enable                 # 用 Node 自带的 corepack
> # 或
> npm install -g pnpm
> ```
> 装完确认 `pnpm --version` 可执行。

**从 GitHub 一键安装（推荐）**

本插件已标注 GitHub [`dsh-plugin` 主题](https://github.com/topics/dsh-plugin)，也可在 `dsh-plugin-marketplace` 的 **Settings → Plugins → Plugin market** 里搜索并一键安装。

```bash
# GitHub 一键安装（推荐，无需发布到 npm）
dsh plugin --profile web add github:rsdgnchen/dsh-terminal
```

**本地源码安装（开发/调试）**

```bash
# 以插件源码目录为准安装（源码 => ~/.dsh/plugins 下统一管理）
dsh plugin --profile web add file:$HOME/.dsh/plugins/dsh-terminal
```

> 若你从源码目录直接安装，也可 `dsh plugin --profile web add file:$HOME/dsh/plugins/dsh-terminal`。

安装后，profile 的 `package.json` 的 `dsh.profile.bundles` 会追加 `@rsdgnchen/dsh-terminal`，并把 `@rsdgnchen/dsh-terminal` 写入依赖。web 服务的 `cordis.patch.yml`（来自插件的 `cordis.patch.yml`）会插入一行：

```yaml
- id: dsh-rsdgnchen-terminal
  name: '@rsdgnchen/dsh-terminal'
```

### 生效

- 因为客户端 bundle 需要在服务启动时重新组合，**需重启/重载 web 服务**：

```bash
pm2 restart dsh          # 若服务由 pm2 托管（本机进程名是 dsh；脚本 ~/bin/dsh-web.sh）
# 或重启 dsh web 进程
```

> **`src/client.js` 与 `src/index.js` 的生效方式不同**：
> - 只改 `src/client.js`：服务端对 client bundle 是 `no-cache` 现读盘、并常驻 HMR 轮询（`dsh-client-hmr`），**刷新浏览器页面即可生效**，通常无需重启。
> - 改了 `src/index.js`（Host 半，如本插件的起始目录逻辑）：**必须重启 web 服务**（Host 插件在启动时装载，没有 HMR）。
> - 改了 `package.json` / `cordis.patch.yml` / bundle 结构：也需重启，且要重新安装依赖。
>
> 另注：profile 现在以 `github:rsdgnchen/dsh-terminal` 安装，**源码目录与 profile 实际加载的副本是两份文件**，改源码不会自动生效——部署流程见 `DEVELOPMENT.md` §7。

## 使用

1. 在对话区底部**上滑那根透明横杠**（或轻点/回车）打开终端。终端会在**当前会话的工作目录**里起 shell（悬停标签可看到实际目录）。
2. `+` 新建标签；点标签切换；**双击标签标题可改名**；`⛶` 铺满/还原高度；`−` 挂起、`×` 关闭。
3. **切换会话**：面板自动换成那个会话的一套终端（已访问过的会话切回去保持不变，后台 shell 照常活着）。
4. 面板**顶部小横杠**：拖动=调整高度，**点击=收起终端**（等同 `−`）；向上滚动回看历史输出（5000 行）。
5. `Ctrl+D` 退出当前 shell（会话结束 → 自动关闭该标签；当前会话最后一个标签则关闭整个面板）。

## 前置要求 / 依赖

- Harness Web profile（`@deepseek-ai/dsh-web-app` + `@deepseek-ai/dsh-base`）。
- 运行环境里存在 `node-pty`（原生模块）与 `ws`。本插件**不把它们声明为自身依赖**，而是在运行时解析：优先 `require('node-pty')`，失败则回退到 Harness 全局安装目录中已构建的副本（复用，避免 node-gyp）。参见 `DEVELOPMENT.md`。
- 浏览器端 xterm.js 5.5.0 已随插件分发（`src/vendor/`），无需联网、无需打包。

## 目录结构

```
dsh-terminal/
├── package.json          # 插件清单：dsh.bundle.patch / dsh.client / exports
├── cordis.patch.yml      # bundle 层：插入 dsh-rsdgnchen-terminal 行
└── src/
    ├── index.js          # Host 半：node-pty 会话 + WebSocket + 静态资源 + 错误日志
    ├── client.js         # 浏览器半：xterm 面板 + 标签页 + 双击重命名 + 明暗自适应 + 挂起/关闭
    └── vendor/           # xterm.js 5.5.0 UMD + css + fit 插件（随插件分发）
```

## 常见问题

- **新建标签报错/终端消失**：见 `DEVELOPMENT.md` 的「t 变量遮蔽」一节——新增标签的 updater 形参不能叫 `t`。
- **终端没开在会话目录，而是 `$HOME`**：说明客户端没读到当前会话的 cwd（会话列表未就绪，或该会话还没记录 cwd）——Host 按优先级回退到了 `$HOME`。重开面板/新建标签即可；想固定某个目录就给 web 服务设 `DSH_TERMINAL_CWD`（它会压过会话目录）。
- **切换会话后终端没跟着换目录**：每个标签在**创建时**冻结目录（shell 的 cwd 只能自己 `cd`）；但**每个会话有自己的一套标签**，切到别的会话会看到那套（新会话会自动开一个终端在其目录里），切回来原来那套原样恢复。
- **切会话后台多了 shell**：这是「每会话一套标签」的代价——面板开着时切到哪个会话，就会为它起一个终端并留在后台。按 `×` 关掉面板即可一次性释放全部（`−` 只隐藏、会保留）。
- **终端连不上 / 401**：升级鉴权已开启，WS 必须带 DSH 的登录态。正常从 GUI 页面打开没问题；用脚本直连需要带上 `dsh-auth-*` cookie（见 `DEVELOPMENT.md`）。
- **终端没有颜色/太暗**：明暗自适应依赖应用主题；若自定义了其它主题，可在 `src/client.js` 的 `buildPalette()` 里补充对应 token。
- **想改回看行数**：`src/client.js` 中 `scrollback: 5000`。

## License

MIT
