// dsh-yaha-terminal — Web 终端插件（Host 半 / 服务端）
//
// 提供两块能力：
//   1. 一个 WebSocket 升级路由 /__yaha-terminal/ws：浏览器连接后即为该连接
//      起一个真实系统交互终端（node-pty 起 $SHELL），双向流式：
//         client→server: {type:'input',data} | {type:'resize',cols,rows} | {type:'kill'}
//         server→client: {type:'ready',pid,cwd} | {type:'output',data}
//                        | {type:'exit',exitCode,signal} | {type:'error',message}
//     PTY 会话随连接建立/关闭，绝不跨连接共享（每浏览器标签页一个独立 shell）。
//   2. 三个静态资源路由，提供 xterm.js 的浏览器端依赖（无需打包、无需联网）：
//         /__yaha-terminal/vendor/xterm.js
//         /__yaha-terminal/vendor/xterm.css
//         /__yaha-terminal/vendor/addon-fit.js
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

const name = 'dsh-yaha-terminal'
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
  { path: '/__yaha-terminal/vendor/xterm.js', file: 'xterm.js', type: 'text/javascript; charset=utf-8' },
  { path: '/__yaha-terminal/vendor/xterm.css', file: 'xterm.css', type: 'text/css; charset=utf-8' },
  { path: '/__yaha-terminal/vendor/addon-fit.js', file: 'addon-fit.js', type: 'text/javascript; charset=utf-8' },
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
const ERROR_LOG = process.env.YAHA_TERMINAL_ERROR_LOG || path.join(os.tmpdir(), 'yaha-terminal-errors.log')

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

// --- PTY 会话 -----------------------------------------------------------------

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)) } catch { /* socket 可能已关 */ }
  }
}

// 默认工作目录：用户在服务器启动时的 PWD，否则 HOME，否则 cwd。
function defaultCwd() {
  return process.env.PWD || process.env.HOME || process.cwd()
}

function spawnSession(ws) {
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : 'bash')
  const cwd = defaultCwd()
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
  wss.on('connection', (ws) => {
    spawnSession(ws)
  })

  function register(host) {
    for (const s of STATIC_FILES) {
      host.register({ kind: 'exact', path: s.path, handler: serveStatic(s.file, s.type) })
    }

    // 客户端运行时错误上报（诊断用）
    host.register({ kind: 'exact', path: '/__yaha-terminal/error', handler: serveErrorLog })

    host.registerUpgrade({
      path: '/__yaha-terminal/ws',
      handler: (req, socket, head) => {
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
