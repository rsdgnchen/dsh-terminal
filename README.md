# @yaha/dsh-terminal

DeepSeek Harness Web 的**系统交互终端插件**：在页面右侧 8 列（对话区）内做上下 `8/2` 分区，上方 8 是对话，下方 2 是一个真实的系统 shell（node-pty 起 `$SHELL`，xterm.js 渲染），用按钮弹出/隐藏。

插件名带 `yaha`，便于你在 `~/.dsh/plugins/` 下统一管理。

![布局示意]
```
┌──────────────┬──────────────────────────────┐
│  侧栏 (2)    │  对话区 (8)                   │
│              │  ┌────────────────────────┐  │
│              │  │  聊天 / 会话           │  │
│              │  │   (占高 8/8)           │  │
│              │  ├────────────────────────┤  │
│              │  │  终端面板 (占高 2/8)    │  │
│              │  │  [Terminal 1][+][-][×] │  │
│              │  └────────────────────────┘  │
└──────────────┴──────────────────────────────┘
```

## 特性

- **真实系统终端**：Host 侧用 `node-pty` 起 `$SHELL`（默认 `SHELL` 环境变量，如 zsh/bash），支持颜色、作业控制、交互式程序（vim / less / top 等）。
- **上下 8/2 分区**：终端出现时，对话区高度真正被压缩（`center` 列加 `padding-bottom`），终端停靠在 `center` 列底部（不遮挡侧栏 / 详情列）。
- **多终端标签页**：蓝色 `+` 新建标签，每个标签一个独立 shell 会话；切换标签**不销毁**会话（`visibility` 叠放，保持尺寸）。
- **挂起 `−` / 关闭 `×`**：
  - `−`（挂起）：只隐藏面板，**保留全部会话与输出**；底部悬浮按钮变成「恢复终端」，点它即可还原。
  - `×`（关闭）：真正卸载面板并杀死全部会话。
  - 顺序为软件惯例：**`− ×`**。
- **编号复用**：标签编号取「当前所有标签中最小的空闲正整数」，关掉后再新建会复用之前的编号（1、2、3 → 关掉 3 → 新建 = 3）。
- **明暗自适应**：xterm 与面板颜色跟随应用主题（识别 `<body data-ds-dark-theme>` 与 `--dsw-*` 语义 token），切换到系统浅色/深色会自动换配色。
- **拖拽调高**：终端顶部拖拽条可调高度（120–520px）。
- **输出回看**：xterm 滚动缓冲默认 **5000 行**（改 `src/client.js` 的 `scrollback`）
- **入口**：对话区底部右角的悬浮按钮（打开/恢复）。头部不再放置终端按钮，保持简洁。

## 安装

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

## 使用

1. 打开对话区底部右角的悬浮按钮「打开终端」。
2. `+` 新建标签；点标签切换；`−` 挂起、`×` 关闭。
3. 顶部拖拽条调高度；向上滚动回看历史输出（5000 行）。

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
    ├── client.js         # 浏览器半：xterm 面板 + 标签页 + 明暗自适应 + 挂起/关闭
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
