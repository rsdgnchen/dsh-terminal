# @yaha/dsh-terminal

DeepSeek Harness Web 的**系统交互终端插件**：在页面右侧 8 列（对话区）内做上下 `8/2` 分区，上方 8 是对话，下方 2 是一个真实的系统 shell（node-pty 起 `$SHELL`，xterm.js 渲染）。底部用 **iOS 风格透明横杠**呼出终端；终端顶部的**小横杠**拖动可调高、**点击可收起**（等同 `−`）。

插件名带 `yaha`，便于你在 `~/.dsh/plugins/` 下统一管理。

![布局示意]
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
- **上下 8/2 分区**：终端出现时，对话区高度真正被压缩（`center` 列加 `padding-bottom`），终端停靠在 `center` 列底部（不遮挡侧栏 / 详情列）。
- **多终端标签页**：蓝色 `+` 新建标签，每个标签一个独立 shell 会话；切换标签**不销毁**会话（`visibility` 叠放，保持尺寸）。
- **挂起 `−` / 关闭 `×`**：
  - `−`（挂起）：只隐藏面板，**保留全部会话与输出**；底部透明横杠用**品牌色点亮**（恢复态），上滑/轻点即可还原。
  - `×`（关闭）：真正卸载面板并杀死全部会话。
  - 顺序为软件惯例：**`− ×`**。
  - **顶部小横杠也能收起**：拖动它调整高度；**点击（未拖动）即收起终端**（等同 `−`，保留会话）。
- **标签可重命名**：**双击**标签标题即可内联改名，`Enter`/失焦保存、`Esc` 取消。
- **会话结束自动关闭**：按 `Ctrl+D`（或 `exit` / 连接断开）会直接关闭该标签；若是最后一个标签则关闭整个面板，**不会驻留「已退出」提示**。
- **编号复用**：标签编号取「当前所有标签中最小的空闲正整数」，关掉后再新建会复用之前的编号（1、2、3 → 关掉 3 → 新建 = 3）。
- **明暗自适应**：xterm 与面板颜色跟随应用主题（识别 `<body data-ds-dark-theme>` 与 `--dsw-*` 语义 token），切换到系统浅色/深色会自动换配色。
- **拖拽调高**：终端顶部拖拽条可调高度（120–520px）。
- **输出回看**：xterm 滚动缓冲默认 **5000 行**（改 `src/client.js` 的 `scrollback`）
- **入口**：对话区底部有一根 **iOS App Switcher 样式的透明横杠**：**上滑**（或轻点/回车）**打开**终端。它在底部预留一条 `HANDLE_STRIP_H`（14px）横条，**不遮挡 dsh 输出统计**；该横条**只在横杠显示时预留**——横杠 3 秒无操作自动淡出后即释放（同滚动条逻辑），避免常驻把对话滚动条压短导致底部缺像素。光标靠近底部时重新亮起。**收起终端用面板顶部的小横杠**（拖动=调高、点击=收起），而不是这根入口横杠。头部不放终端按钮，保持简洁。

## 安装

> 前置条件：**需先安装 pnpm，并确保在 `PATH` 上**。`dsh plugin` 会把参数转发给 `pnpm`（在 profile 目录里管理依赖），没有 pnpm 会报 `dsh: pnpm not found on PATH`。
> 安装 pnpm（任选其一）：
> ```bash
> corepack enable                 # 用 Node 自带的 corepack
> # 或
> npm install -g pnpm
> ```
> 装完确认 `pnpm --version` 可执行。

在 web profile 里作为 bundle 加入（`file:` 指向插件目录）：

```bash
# 以插件源码目录为准安装（推荐：源码 => ~/.dsh/plugins 下统一管理）
dsh plugin --profile web add file:$HOME/.dsh/plugins/dsh-terminal
```

> 若你从源码目录直接安装，也可 `dsh plugin --profile web add file:$HOME/dsh/plugins/dsh-terminal`。

安装后，profile 的 `package.json` 的 `dsh.profile.bundles` 会追加 `@yaha/dsh-terminal`，并把 `@yaha/dsh-terminal` 写入依赖。web 服务的 `cordis.patch.yml`（来自插件的 `cordis.patch.yml`）会插入一行：

```yaml
- id: dsh-yaha-terminal
  name: '@yaha/dsh-terminal'
```

### 生效

- 因为客户端 bundle 需要在服务启动时重新组合，**需重启/重载 web 服务**：

```bash
pm2 restart dsh-web      # 若服务由 pm2 托管（本项目如此）
# 或重启 dsh web 进程
```

> 若只改了 `src/client.js`：服务端对 client bundle 是 `no-cache` 现读盘、并常驻 HMR 轮询（`dsh-client-hmr`），**刷新浏览器页面即可生效**，通常无需重启；改动 `package.json` / `cordis.patch.yml` / bundle 结构时才需要按上面重启。

## 使用

1. 在对话区底部**上滑那根透明横杠**（或轻点/回车）打开终端。
2. `+` 新建标签；点标签切换；**双击标签标题可改名**；`−` 挂起、`×` 关闭。
3. 面板**顶部小横杠**：拖动=调整高度，**点击=收起终端**（等同 `−`）；向上滚动回看历史输出（5000 行）。
4. `Ctrl+D` 退出当前 shell（会话结束 → 自动关闭该标签/面板）。

## 前置要求 / 依赖

- Harness Web profile（`@deepseek-ai/dsh-web-app` + `@deepseek-ai/dsh-base`）。
- 运行环境里存在 `node-pty`（原生模块）与 `ws`。本插件**不把它们声明为自身依赖**，而是在运行时解析：优先 `require('node-pty')`，失败则回退到 Harness 全局安装目录中已构建的副本（复用，避免 node-gyp）。参见 `DEVELOPMENT.md`。
- 浏览器端 xterm.js 5.5.0 已随插件分发（`src/vendor/`），无需联网、无需打包。

## 目录结构

```
dsh-terminal/
├── package.json          # 插件清单：dsh.bundle.patch / dsh.client / exports
├── cordis.patch.yml      # bundle 层：插入 dsh-yaha-terminal 行
└── src/
    ├── index.js          # Host 半：node-pty 会话 + WebSocket + 静态资源 + 错误日志
    ├── client.js         # 浏览器半：xterm 面板 + 标签页 + 双击重命名 + 明暗自适应 + 挂起/关闭
    └── vendor/           # xterm.js 5.5.0 UMD + css + fit 插件（随插件分发）
```

## 常见问题

- **新建标签报错/终端消失**：见 `DEVELOPMENT.md` 的「t 变量遮蔽」一节——新增标签的 updater 形参不能叫 `t`。
- **终端没有颜色/太暗**：明暗自适应依赖应用主题；若自定义了其它主题，可在 `src/client.js` 的 `buildPalette()` 里补充对应 token。
- **想改回看行数**：`src/client.js` 中 `scrollback: 5000`。

## 相关插件

- `@yaha/dsh-session-delete`：会话删除（头部删除按钮已按需移除，删除保留在工作区会话行三点菜单）。

## License

MIT
