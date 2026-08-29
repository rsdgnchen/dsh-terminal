# ⚠️ 开发上下文（必读）—— 本地源码 ≠ 已部署副本

> 给未来打开这个项目的你（开发者 / 智能体）：**先看这一条再动手，能避免「改了源码却毫无反应」的坑。**
> —— 本插件已经从源码升级为「从 GitHub 一键安装」，源码目录和 profile 实际加载的副本已经**不再是同一份**。

## 一句话结论
现在 `@yaha/dsh-terminal` 是以 **`github:rsdgnchen/dsh-terminal`** 安装进 profile 的，
**本地源码目录** 与 **profile 里实际加载的副本** 是**两个不同的文件**。
**改本地源码不会自动反映到正在运行的 `dsh-web`。**

## 三个「家」，别搞混
| 角色 | 路径 | 说明 |
|---|---|---|
| **源码 / 作者目录（git 仓库）** | `/home/yaha/dsh/plugins/dsh-terminal` | ✅ 在这里编辑、提交、推送 |
| **profile 实际加载的副本** | `/home/yaha/.dsh/profiles/web/node_modules/@yaha/dsh-terminal` | ⚠️ 由 `github:rsdgnchen/dsh-terminal` 装来的**独立副本**，服务端读的是它 |
| 历史 `cp` 拷贝 | `/home/yaha/.dsh/plugins/dsh-terminal` | 旧部署位置，当前**不引用**（profile 不用它） |

## 为什么不一样
profile 的 `package.json` 现在把依赖声明为：
```json
"@yaha/dsh-terminal": "github:rsdgnchen/dsh-terminal",
```
`pnpm` 据此把它装进 `node_modules` 成为**独立副本**（不再像 `file:` 那样与源码硬链接同 inode）。

## 改了源码 → 怎么让它生效（标准流程）
```bash
cd /home/yaha/dsh/plugins/dsh-terminal
git add -A && git commit -m "你的说明" && git push
cd ~/.dsh/profiles/web && pnpm update @yaha/dsh-terminal
pm2 restart dsh-web
```
> - `pnpm update` 拉的是 GitHub 仓库默认分支（`main`）。
> - 提交前先 `git status` 确认确实有改动，避免 `git commit` 报「nothing to commit」并让 `&& git push` 短路。
> - 服务端 client/host bundle 需在**启动时重组**，因此改完必须 `pm2 restart dsh-web`（稳妥起见；个别 client 改动靠刷新也可，但别依赖）。

## 想本地即时调试（不走 GitHub）
把 profile 切回 `file:` 本地源，让「源码 == 加载副本」恢复一致：
```bash
dsh plugin --profile web add file:$HOME/dsh/plugins/dsh-terminal
pm2 restart dsh-web
```
之后改 `src/**` 刷新即可看到。验证完如需回到 GitHub 安装，再 `dsh plugin --profile web add github:rsdgnchen/dsh-terminal` 并重启。

## 相关事实（备忘）
- GitHub 仓库：`https://github.com/rsdgnchen/dsh-terminal`（**公开**）；Topics 已含 `dsh-plugin`（可在 https://github.com/topics/dsh-plugin 与 `dsh-plugin-marketplace` 里被发现、一键安装）。
- profile 另一个插件 `@yaha/dsh-session-delete` 仍是 `file:/home/yaha/.dsh/plugins/dsh-session-delete`（**其源码 `~/dsh/plugins/dsh-session-delete` 与它也是两套**，同样「源码≠部署」）。
- 运行时机、宿主 API 等其余细节见 `DEVELOPMENT.md`；用户向功能与安装见 `README.md`。

## 快速检查「服务端用的是哪一份」
```bash
# 本地加载副本的哈希
sha256sum ~/.dsh/profiles/web/node_modules/@yaha/dsh-terminal/src/client.js
# 服务端实际下发的内容哈希
curl -s http://127.0.0.1:3080/plugins/@yaha/dsh-terminal/client.js | sha256sum
# 两行一致 → 服务端用的就是该副本
```
