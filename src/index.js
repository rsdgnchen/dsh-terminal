// dsh-rsdgnchen-terminal — Web 终端插件（Host 半 / 服务端）
//
// 提供两块能力：
//   1. 一个 WebSocket 升级路由 /__rsdgnchen-terminal/ws：浏览器连接后即为该连接
//      起一个真实系统交互终端（node-pty 起 $SHELL），双向流式：
//         client→server: {type:'input',data} | {type:'resize',cols,rows} | {type:'kill'}
//         server→client: {type:'ready',pid,cwd} | {type:'output',data}
//                        | {type:'exit',exitCode,signal} | {type:'error',message}
//     PTY 会话随连接建立/关闭，绝不跨连接共享（每浏览器标签页一个独立 shell）。
//     升级请求先过 DSH 的 Host/Origin 围栏 + 浏览器鉴权（connection.requestRejection），
//     未通过则回 401/403 并断开——registerUpgrade 本身不做鉴权，必须自己挡。
//   2. 三个静态资源路由，提供 xterm.js 的浏览器端依赖（无需打包、无需联网）：
//         /__rsdgnchen-terminal/vendor/xterm.js
//         /__rsdgnchen-terminal/vendor/xterm.css
//         /__rsdgnchen-terminal/vendor/addon-fit.js
//     这些文件随插件一起分发（src/vendor/*），由服务器以 no-cache 出流，
//     客户端首次打开终端时按需加载。
//
// 依赖加载：node-pty / ws 不声明为插件依赖，而是走运行时解析——
// 优先正常 require，失败则回退到 Harness 安装目录里已经编译好的副本
// （node-pty 是原生模块，复用 Harness 构建避免 node-gyp）。
//
// Cordis bundle 规则：named exports apply/inject/name。所有注册挂在插件 fiber
// （ctx.effect / ctx.inject 子 fiber）上，随插件停用一并回收。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const name = 'dsh-rsdgnchen-terminal'
const inject = []

const require = createRequire(import.meta.url)

// --- 运行时解析 node-pty / ws -------------------------------------------------
//
// 先按常规解析（若作为依赖安装），否则回退到 Harness 全局安装目录中已构建的
// 副本。node-pty 已由 dsh 依赖并在进程内加载，重复 require 同一文件无害。
function harnessModule(moduleName) {
  const versionDir = path.dirname(path.dirname(process.execPath))
  const globalModules = path.join(versionDir, 'lib', 'node_modules')
  return path.join(globalModules, '@deepseek-ai', 'dsh', 'node_modules', moduleName)
}

function loadModule(moduleName) {
  try {
    return require(moduleName)
  } catch {
    return require(harnessModule(moduleName))
  }
}

const pty = loadModule('node-pty')
const { WebSocketServer } = loadModule('ws')

// --- 静态资源目录 -------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))
const vendorDir = path.join(here, 'vendor')

const STATIC_FILES = [
  { path: '/__rsdgnchen-terminal/vendor/xterm.js', file: 'xterm.js', type: 'text/javascript; charset=utf-8' },
  { path: '/__rsdgnchen-terminal/vendor/xterm.css', file: 'xterm.css', type: 'text/css; charset=utf-8' },
  { path: '/__rsdgnchen-terminal/vendor/addon-fit.js', file: 'addon-fit.js', type: 'text/javascript; charset=utf-8' },
]

function serveStatic(file, type) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    let body
    try {
      body = fs.readFileSync(path.join(vendorDir, file))
    } catch {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-cache',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

// 客户端上报的运行时错误（诊断用）：追加到固定文件，便于故障排查。
const ERROR_LOG = process.env.RSDGNCHEN_TERMINAL_ERROR_LOG || path.join(os.tmpdir(), 'rsdgnchen-terminal-errors.log')

function serveErrorLog(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    try {
      fs.appendFileSync(ERROR_LOG, `\n[${new Date().toISOString()}]\n${body}\n`)
      res.writeHead(204)
      res.end()
    } catch {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'write failed' }))
    }
  })
  req.on('error', () => { try { res.destroy() } catch {} })
}

// --- upgrade 鉴权 -------------------------------------------------------------
// webServer 的 registerUpgrade 只按路径分发、**不做任何鉴权**：落在原始 socket 上的
// 请求谁都能连。若不复用 DSH 的检查，「任意网页」都能对 127.0.0.1:3080 起一个
// *不受沙箱约束* 的 shell（WebSocket 不受 CORS 限制），ssh -L 也挡不住——发起方
// 是浏览器本身。故复用 connection 服务的公开检查：
//   requestRejection(req) → 403 非可信 Host/Origin（含 DNS rebinding）｜ 401 未鉴权
// 它对 loopback 的任意端口都放行，且鉴权 cookie 按 Host authority 签发，所以
// `ssh -L 8080:127.0.0.1:3080` 这种映射到别的本地端口也能正常通过。
function upgradeRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (connection && typeof connection.requestRejection === 'function') {
    return connection.requestRejection(req)
  }
  // 退化路径（没有 connection 服务时）：至少做同源 / 非跨站校验。
  const headers = req.headers || {}
  if (!headers.host) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  if (headers.origin === undefined) return undefined // 非浏览器客户端
  try {
    return new URL(headers.origin).host === headers.host ? undefined : 403
  } catch {
    return 403
  }
}

// 在原始 socket 上回一个最小 HTTP 响应再断开（upgrade 阶段还没有 ws 对象）。
function rejectUpgrade(socket, status) {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  } catch { /* 忽略 */ }
  try { socket.destroy() } catch { /* 忽略 */ }
}

// --- PTY 会话 -----------------------------------------------------------------

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)) } catch { /* socket 可能已关 */ }
  }
}

// 起始目录 = 该标签创建那一刻「当前会话的工作目录」。
// 客户端从 ctx.sessions 的当前会话快照里读出 Host 下发的 cwd，作为
// /__rsdgnchen-terminal/ws?cwd=<encoded> 的查询参数带上来。
//
// 只信任「已存在的绝对目录」：解析失败 / 不存在 / 不是目录一律忽略，回退默认目录。
// 顺带 realpath（解析符号链接），让 pty 的 cwd 与用户看到的字符串指向同一目录。
function requestedCwd(req) {
  try {
    const raw = new URL(req.url || '/', 'http://localhost').searchParams.get('cwd')
    if (!raw || !path.isAbsolute(raw)) return undefined
    const real = fs.realpathSync(raw)
    return fs.statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

// 目录优先级：显式配置（部署固定目录）> 会话工作目录 > HOME > 进程 cwd。
// 注意：不能信任 process.env.PWD —— 插件跑在常驻服务里（pm2/systemd 拉起），
// PWD 是「服务被启动那一刻」的目录，会随启动位置漂移（例如从 ~/bin 起
// pm2 后，每个终端都开在 ~/bin），而 process.cwd() 同样是那个目录。
function resolveCwd(sessionCwd) {
  return process.env.DSH_TERMINAL_CWD || sessionCwd || process.env.HOME || process.cwd()
}

function spawnSession(ws, sessionCwd) {
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : 'bash')
  const cwd = resolveCwd(sessionCwd)
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }

  let term
  try {
    term = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env })
  } catch (e) {
    send(ws, { type: 'error', message: `spawn ${shell} failed: ${e && e.message ? e.message : e}` })
    return
  }

  // 回报真正生效的起始目录（客户端据此显示标签提示；cwd 回退时也能看出实际值）。
  send(ws, { type: 'ready', pid: term.pid, cwd })

  term.onData((data) => send(ws, { type: 'output', data }))

  term.onExit(({ exitCode, signal }) => {
    send(ws, { type: 'exit', exitCode, signal })
  })

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      // 非 JSON：当作直接输入
      term.write(String(raw))
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data)
    } else if (msg.type === 'resize') {
      const cols = Math.max(2, parseInt(msg.cols, 10) || 2)
      const rows = Math.max(1, parseInt(msg.rows, 10) || 1)
      try { term.resize(cols, rows) } catch { /* 已关闭则忽略 */ }
    } else if (msg.type === 'kill') {
      try { term.kill() } catch { /* 已关闭 */ }
    }
  })

  ws.on('close', () => {
    try { term.kill() } catch { /* 已关闭 */ }
  })
}

// --- 插件主体 -----------------------------------------------------------------
// webServer 是可选服务：有就注册 WS 升级 + 静态路由；暂无则等它出现（ctx.inject
// 子 fiber，随本插件上下文销毁）。终端型 profile 没有 web 面时不挂载端点。

function apply(ctx) {
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws, req) => {
    // req 由 registerUpgrade 的 handleUpgrade 回传（含查询串，用于取会话工作目录）。
    spawnSession(ws, requestedCwd(req))
  })

  function register(host) {
    for (const s of STATIC_FILES) {
      host.register({ kind: 'exact', path: s.path, handler: serveStatic(s.file, s.type) })
    }

    // 客户端运行时错误上报（诊断用）
    host.register({ kind: 'exact', path: '/__rsdgnchen-terminal/error', handler: serveErrorLog })

    host.registerUpgrade({
      path: '/__rsdgnchen-terminal/ws',
      handler: (req, socket, head) => {
        // 先过 DSH 的 Host/Origin 围栏 + 浏览器鉴权，再交出 socket。
        const rejection = upgradeRejection(ctx, req)
        if (rejection !== undefined) {
          rejectUpgrade(socket, rejection)
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req)
        })
      },
    })
  }

  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    register(ws)
  } else {
    ctx.inject(['webServer'], (sub) => {
      register(sub.webServer)
    })
  }

  ctx.effect(() => {
    return () => {
      try { wss.close() } catch { /* 已关闭 */ }
    }
  })
}

export { apply, inject, name }
