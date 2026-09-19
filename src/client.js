// dsh-rsdgnchen-terminal — Web 终端插件（Client 半 / 浏览器）
//
// 在右侧 8 列内做一个上下 8/2 分区：上方 8 是对话区，下方 2 是系统交互终端。
// 通过对话区底部停靠的细条按钮弹出/隐藏（shell.overlay 的常驻把手），支持：
//   每会话一套标签（切会话自动换那套，别套仍在后台存活）、多标签页
//   （每标签独立会话，切换 / 挂起不销毁）、拖拽调高、一键铺满、明暗自适应。
// 终端本体是 shell.overlay 的一个 additive entry（不会替换任何现有内容）。
// 打开时：
//   1. 按 AppFrame 的 grid 列宽把终端停靠在 center 列底部（left/right 对齐，
//      不吃 sidebar / details）；
//   2. 给 center 列加 padding-bottom = (shown ? H : HANDLE_STRIP_H)，从而真正压缩
//      对话区（上8下2）；底部常驻 HANDLE_STRIP_H 横条放把手、不挡输出统计；
//   3. xterm.js 按需加载（Host 提供的 vendor 静态文件），连 WebSocket 双向流式；
//      起始目录取当前会话的 cwd（Host 校验后使用）；
//   4. 顶部拖拽条可调终端高度，点击（未拖动）收起终端（等同 −）；
//      标题栏 ⛶ 一键铺满 / 还原高度；
//      底部「透明横杠」（iOS 主屏指示条风格）上滑/轻点打开，挂起时用品牌色点亮。
// 面板状态（TerminalOverlay 本地态）：mounted=有会话面板块挂载（保留会话）；
//   shown=面板可见；keys=已登记面板的会话。挂起(−)=shown=false 但保留会话；
//   关闭(×)=卸载全部门板并杀全部会话。
//
// Bundle 格式（client-modules 协议）：classic script 注册 factory——
// window.__ModuleLoader__.load({ id, factory })，factory 接收 require 并返回
// 插件导出（apply 等）。无 JSX，纯 React.createElement；样式用内联 + --dsw-*
// 主题 token。

window.__ModuleLoader__.load({
  id: '@rsdgnchen/dsh-terminal',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React

    const OVERLAY_SLOT = 'shell.overlay'
    const OVERLAY_ID = 'rsdgnchen-terminal'
    const WS_PATH = '/__rsdgnchen-terminal/ws'

    const TERM_MIN_H = 120
    const TERM_DEFAULT_H = 200
    const TERM_MAX_H = 520
    // 给底部把手预留的常驻横条高度：容纳「2px 下边距 + 5px 横杠 + 1px 余量」，
    // 让输出统计/内容盖不住把手，把手也不遮挡统计。常驻预留从而没有显隐跳动。
    const HANDLE_STRIP_H = 8

    // --- 文案 ---------------------------------------------------------------
    const zhDict = {
      'open': '打开终端',
      'restore': '恢复终端',
      'close': '关闭终端',
      'minimize': '挂起（保留会话）',
      'new': '新建终端',
      'maximize': '铺满高度',
      'restoreH': '还原高度',
    }
    const enDict = {
      'open': 'Open terminal',
      'restore': 'Restore terminal',
      'close': 'Close terminal',
      'minimize': 'Suspend (keep session)',
      'new': 'New terminal',
      'maximize': 'Maximize height',
      'restoreH': 'Restore height',
    }
    function lang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const p = String(tag || '').toLowerCase().split('-')[0]
        if (p === 'zh' || p === 'en') return p
      }
      return 'zh'
    }
    function t(k) { return (lang() === 'en' ? enDict : zhDict)[k] || k }

    // --- 会话（id + 工作目录） -----------------------------------------------
    // 从 dsh-api-session-controller 的 client 服务（ctx.sessions）读会话记录：
    // id 用于「每会话一套标签」，cwd 用于「终端起始目录」（Host 下发的权威值，
    // 与核心终端的「Session workspace」同源）。
    // `wantedId` 缺省 = 当前选中会话；显式传入时读**那个**会话——后台面板里
    // 新建标签必须用该面板自己会话的 cwd，而不是此刻选中的会话。
    // 纯只读、可失败：服务未就绪 / 无此会话 → 两者皆 undefined（cwd 由 Host
    // 回退到默认目录，id 退化成 NO_SESSION_KEY 这一个"无会话"面板）。
    // 刻意不写进 inject：拿不到服务时插件照常挂载，而不是整个入口因依赖缺失而消失。
    const NO_SESSION_KEY = '__no_session__'

    function readSession(ctx, wantedId) {
      try {
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
        const list = sessions && sessions.list
        const snap = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null
        if (!snap) return { id: undefined, cwd: undefined }
        const id = wantedId || snap.current
        if (!id) return { id: undefined, cwd: undefined }
        // 兼容两种 list 快照形状：{ids,byId} 与 {items}。
        let rec = snap.byId ? snap.byId[id] : undefined
        if (!rec && Array.isArray(snap.items)) {
          rec = snap.items.find((x) => x && (x.sessionId === id || x.id === id))
        }
        const cwd = rec && rec.cwd
        return { id: String(id), cwd: typeof cwd === 'string' && cwd ? cwd : undefined }
      } catch {
        return { id: undefined, cwd: undefined }
      }
    }

    // 订阅会话列表变化（切换会话要即时换一套标签）。通知不带载荷：回调里重读快照。
    // 服务/接口缺失时退化为 no-op 退订函数。
    function subscribeSessions(ctx, fn) {
      try {
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
        const list = sessions && sessions.list
        if (list && typeof list.subscribe === 'function') {
          const off = list.subscribe(fn)
          return typeof off === 'function' ? off : () => {}
        }
      } catch { /* 忽略 */ }
      return () => {}
    }

    // 当前会话 key 的响应式版本：订阅变化 → setState → 触发换面板。
    function useSessionKey(sessionKey, subscribe) {
      const [key, setKey] = useState(() => sessionKey())
      useEffect(() => {
        setKey(sessionKey())
        return subscribe(() => setKey(sessionKey()))
      }, [sessionKey, subscribe])
      return key
    }

    // --- 客户端运行时错误上报（诊断用） ---------------------------------------
    function reportError(name, data) {
      try {
        fetch('/__rsdgnchen-terminal/error', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: name + '\n' + (typeof data === 'string' ? data : String(data)),
        }).catch(() => {})
      } catch { /* 忽略 */ }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('error', (e) => {
        reportError('WINDOW_ERROR', (e && e.message || '') + '\n' + (e && e.filename || '') + ':' + (e && e.lineno || '') + '\n' + ((e && e.error && e.error.stack) || ''))
      })
      window.addEventListener('unhandledrejection', (e) => {
        const r = e && e.reason
        reportError('UNHANDLED_REJECTION', (r && r.stack ? r.stack : String(r || 'unknown')))
      })
    }

    // --- 终端滚动条：默认透明，滚轮/触摸/悬停后显示，3 秒无操作自动隐藏 --------
    const SCROLL_CSS =
      '.xterm .xterm-viewport::-webkit-scrollbar{width:10px;height:10px}' +
      '.xterm .xterm-viewport::-webkit-scrollbar-thumb{background:transparent}' +
      '.xterm .xterm-viewport.rsdgnchen-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.45))}' +
      '.xterm .xterm-viewport.rsdgnchen-scroll::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-bg-l1,rgba(128,128,128,.7))}' +
      '.xterm .xterm-viewport{scrollbar-width:thin;scrollbar-color:transparent transparent}' +
      '.xterm .xterm-viewport.rsdgnchen-scroll{scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.45)) transparent}'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="@rsdgnchen/dsh-terminal/scrollbar"]')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@rsdgnchen/dsh-terminal'
      tag.dataset.pluginCss = '@rsdgnchen/dsh-terminal/scrollbar'
      tag.textContent = SCROLL_CSS
      document.head.appendChild(tag)
    }

    // --- 对话消息滚动条：只显示滑块、透明轨道（对齐 DeepSeek/Gemini 观感） -----
    // 浏览器窗口是圆角、滚动条轨道是直角，底部那圈「多出来的像素」盖不住、显得割裂。
    // 把轨道设为透明（只剩滑块）后，直角轨道不再可见，也就没有割裂。
    // 目标为 dsh 对话滚动容器：.Md3f7G_scroll（消息滚动体）+ .wSkVaW_scrollBody（滚动体）。
    // 关键：每个 ::-webkit-scrollbar 选择器必须各自带上伪元素后缀，否则逗号会拆出
    // 「整段元素」选择器（例如 .Md3f7G_scroll{width:8px}），把容器压成 8px 宽、导致每行单字母。
    // 注意：这两个是 dsh 当前构建的 module-scoped 哈希类名，升级后可能变化（失效无害）。
    const CONV_SCROLL_SEL = '.Md3f7G_scroll, .wSkVaW_scrollBody'
    const CONV_SCROLL_PSEUDO = (p) => CONV_SCROLL_SEL.split(', ').map((s) => s.trim() + p).join(', ')
    const CONV_SCROLL_CSS =
      CONV_SCROLL_PSEUDO('::-webkit-scrollbar') + '{width:8px;height:8px}' +
      CONV_SCROLL_PSEUDO('::-webkit-scrollbar-track') + '{background:transparent}' +
      CONV_SCROLL_PSEUDO('::-webkit-scrollbar-thumb') + '{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.45));border-radius:999px;background-clip:padding-box;border:2px solid transparent}' +
      CONV_SCROLL_PSEUDO('::-webkit-scrollbar-thumb:hover') + '{background:var(--dsw-alias-scrollbar-bg-l1,rgba(128,128,128,.7))}' +
      CONV_SCROLL_SEL + '{scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.45)) transparent}'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="@rsdgnchen/dsh-terminal/conv-scrollbar"]')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@rsdgnchen/dsh-terminal'
      tag.dataset.pluginCss = '@rsdgnchen/dsh-terminal/conv-scrollbar'
      tag.textContent = CONV_SCROLL_CSS
      document.head.appendChild(tag)
    }

    // --- 自适应明暗（跟随应用主题，含系统跟随） -------------------------------
    // 应用的主题：ui-layout 的 presenter 在 body 上打 `data-ds-dark-theme`
    // 属性（dark 时存在），并把解析后的 --dsw-* 语义 token 写到 body.style。
    // 我们据此读取当前明/暗的真实颜色，并在主题切换时重新应用。
    const ANSI_DARK = ['#161b22', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4', '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#76e3ea', '#f0f6fc']
    const ANSI_LIGHT = ['#24292f', '#cf222e', '#116329', '#953800', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#9a6700', '#0a3069', '#6639ba', '#0e7a8b', '#57606a']

    function readCss(name, fallback) {
      try {
        const v = getComputedStyle(document.body).getPropertyValue(name).trim()
        return v || fallback
      } catch { return fallback }
    }

    function buildPalette() {
      const dark = typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme')
      const bg = readCss('--dsw-alias-bg-base', dark ? '#0d1117' : '#ffffff')
      const fg = readCss('--dsw-alias-label-primary', dark ? '#e6edf3' : '#1f2328')
      const fg2 = readCss('--dsw-alias-label-secondary', dark ? '#8b949e' : '#57606a')
      const accent = readCss('--dsw-alias-brand-primary', dark ? '#58a6ff' : '#0969da')
      const border = readCss('--dsw-alias-border-l2', dark ? 'rgba(128,128,128,.25)' : 'rgba(128,128,128,.2)')
      return {
        dark,
        bg,
        fg,
        fg2,
        accent,
        border,
        selection: dark ? '#264f78' : '#b6d7ff',
      }
    }

    function buildTermTheme(p) {
      const an = p.dark ? ANSI_DARK : ANSI_LIGHT
      return {
        background: p.bg,
        foreground: p.fg,
        cursor: p.accent,
        cursorAccent: p.bg,
        selectionBackground: p.selection,
        black: an[0], red: an[1], green: an[2], yellow: an[3], blue: an[4], magenta: an[5], cyan: an[6], white: an[7],
        brightBlack: an[8], brightRed: an[9], brightGreen: an[10], brightYellow: an[11], brightBlue: an[12], brightMagenta: an[13], brightCyan: an[14], brightWhite: an[15],
      }
    }

    // 把 #rrggbb 转成带透明度的 rgba()，供内联样式叠加半透明高亮。
    function alpha(hex, a) {
      const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
      if (!m) return hex
      const n = parseInt(m[1], 16)
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
    }

    function useAppPalette() {
      const [palette, setPalette] = useState(() => buildPalette())
      useEffect(() => {
        function update() { setPalette(buildPalette()) }
        const el = document.body
        if (!el) return
        const mo = new MutationObserver(update)
        mo.observe(el, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
        return () => mo.disconnect()
      }, [])
      return palette
    }

    // --- xterm 按需加载（Host vendor 静态文件） ------------------------------
    let xtermPromise = null
    function loadXterm() {
      if (xtermPromise) return xtermPromise
      xtermPromise = new Promise((resolve, reject) => {
        function injectTag(kind, attrs) {
          return new Promise((res, rej) => {
            const el = document.createElement(kind)
            for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
            el.addEventListener('load', () => res(el), { once: true })
            el.addEventListener('error', () => rej(new Error('load failed: ' + attrs.href || attrs.src)), { once: true })
            document.head.append(el)
          })
        }
        const LINK = (h) => injectTag('link', { rel: 'stylesheet', href: h })
        const SCRIPT = (s) => injectTag('script', { src: s, async: 'true' })
        Promise.all([
          LINK('/__rsdgnchen-terminal/vendor/xterm.css'),
          SCRIPT('/__rsdgnchen-terminal/vendor/xterm.js'),
          SCRIPT('/__rsdgnchen-terminal/vendor/addon-fit.js'),
        ]).then(() => {
          if (typeof window.Terminal !== 'function') {
            return reject(new Error('xterm not loaded'))
          }
          resolve()
        }).catch(reject)
      })
      return xtermPromise
    }

    // --- 框架测量（AppFrame grid 列宽 / center 列） --------------------------
    function getOverlayLayer() { return document.querySelector('[data-shell-overlay]') }
    function getFrame() { const o = getOverlayLayer(); return o ? o.parentElement : null }
    // 解析 frame 的 gridTemplateColumns："280px minmax(0, 1fr) 0px" -> {sidebar, details}
    function parseGrid(frame) {
      const s = frame && frame.style ? frame.style.gridTemplateColumns : ''
      const m = /^\s*([\d.]+)px\s+minmax\([^)]*\)\s+([\d.]+)px\s*$/.exec(s)
      return {
        sidebar: m ? parseFloat(m[1]) : 280,
        details: m ? parseFloat(m[2]) : 0,
      }
    }
    // center 列 = frame 第 2 个元素子节点（sidebar/center/details/overlay/handles 顺序）
    function getCenterCol(frame) {
      if (!frame) return null
      const kids = frame.children
      // 第 0 个是 sidebar，第 1 个是 center，第 2 个是 details
      return kids && kids.length >= 2 ? kids[1] : null
    }

    // 测量并把列宽放进 state（依赖 ResizeObserver 跟随拖拽变化）
    function useFrameMetrics() {
      const [metrics, setMetrics] = useState({ sidebar: 280, details: 0 })
      const [frame, setFrame] = useState(null)
      const [center, setCenter] = useState(null)
      useEffect(() => {
        function measure() {
          const f = getFrame()
          if (!f) return
          setFrame(f)
          setCenter(getCenterCol(f))
          setMetrics(parseGrid(f))
        }
        measure()
        const el = getFrame()
        if (!el) return
        const ro = new ResizeObserver(() => measure())
        ro.observe(el)
        return () => ro.disconnect()
      }, [])
      return { metrics, frame, center }
    }

    // --- 终端视图（xterm + WS） ---------------------------------------------
    function TerminalView(props) {
      const palette = props.palette
      const active = props.active !== false
      const containerRef = useRef(null)
      const termRef = useRef(null)
      const fitRef = useRef(null)
      const wsRef = useRef(null)
      const paletteRef = useRef(palette)
      paletteRef.current = palette
      const onExitRef = useRef(props.onExit)
      onExitRef.current = props.onExit
      const onReadyRef = useRef(props.onReady)
      onReadyRef.current = props.onReady
      const [status, setStatus] = useState('loading')

      useEffect(() => {
        let disposed = false
        let ended = false
        function handleEnded() {
          if (ended) return
          ended = true
          // 会话结束（如 Ctrl+D / exit / 连接断开）：直接关闭该标签，而不是驻留提示。
          if (!disposed && typeof onExitRef.current === 'function') {
            try { onExitRef.current() } catch { /* 忽略 */ }
          }
        }
        let ws = null
        let term = null
        let fit = null
        let scrollCleanup = null
        async function boot() {
          try {
            await loadXterm()
          } catch (e) {
            if (disposed) return
            setStatus('error')
            return
          }
          if (disposed || !containerRef.current) return
          try {
            term = new window.Terminal({
              cursorBlink: true,
              fontSize: 13,
              fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", "Courier New", monospace',
              scrollback: 5000,
              allowProposedApi: true,
              theme: buildTermTheme(paletteRef.current),
            })
            const WFit = window.FitAddon && window.FitAddon.FitAddon ? window.FitAddon.FitAddon : null
            if (WFit) {
              fit = new WFit()
              term.loadAddon(fit)
            }
            term.open(containerRef.current)
            termRef.current = term
            fitRef.current = fit

            // 首次打开/该标签刚建好时，若本页是活动页则聚焦终端（可靠聚焦，不再依赖
            // 容器 resize 顺带触发）——方案 B：打开即默认接管键盘。用 rAF 等一帧拿真实尺寸。
            if (active) {
              requestAnimationFrame(() => {
                try { if (fit) fit.fit() } catch { /* 忽略 */ }
                try { term.focus() } catch { /* 忽略 */ }
              })
            }

            // 终端滚动条：滚轮/触摸/拖滚动条/悬停 时显示，3 秒无操作后自动隐藏。
            const vp = containerRef.current.querySelector('.xterm-viewport')
            if (vp) {
              let hideTimer = null
              const kick = () => {
                vp.classList.add('rsdgnchen-scroll')
                clearTimeout(hideTimer)
                hideTimer = setTimeout(() => vp.classList.remove('rsdgnchen-scroll'), 3000)
              }
              vp.addEventListener('wheel', kick, { passive: true })
              vp.addEventListener('touchstart', kick, { passive: true })
              vp.addEventListener('touchmove', kick, { passive: true })
              vp.addEventListener('mousedown', kick)
              vp.addEventListener('pointerenter', kick)
              kick()
              scrollCleanup = () => {
                clearTimeout(hideTimer)
                vp.removeEventListener('wheel', kick)
                vp.removeEventListener('touchstart', kick)
                vp.removeEventListener('touchmove', kick)
                vp.removeEventListener('mousedown', kick)
                vp.removeEventListener('pointerenter', kick)
                vp.classList.remove('rsdgnchen-scroll')
              }
            }

            const proto = location.protocol === 'https:' ? 'wss' : 'ws'
            // 起始目录：把「本标签创建那一刻当前会话的 cwd」带给 Host（Host 校验后使用）。
            // 无 cwd 时不带参数，Host 回退到 DSH_TERMINAL_CWD / $HOME。
            const cwd = typeof props.cwd === 'string' && props.cwd ? props.cwd : ''
            ws = new WebSocket(proto + '://' + location.host + WS_PATH + (cwd ? '?cwd=' + encodeURIComponent(cwd) : ''))
            wsRef.current = ws
            ws.onopen = () => {
              if (disposed) return
              setStatus('connected')
              if (fit) fit.fit()
              sendResize()
            }
            ws.onmessage = (e) => {
              let m
              try { m = JSON.parse(e.data) } catch { return }
              if (!term) return
              if (m.type === 'output') term.write(m.data)
              else if (m.type === 'ready') {
                // Host 回报真正生效的起始目录（可能是回退值），用于标签提示。
                if (typeof onReadyRef.current === 'function') {
                  try { onReadyRef.current(m.cwd) } catch { /* 忽略 */ }
                }
              }
              else if (m.type === 'error') term.write('\r\n\x1b[31m' + String(m.message || '') + '\x1b[0m\r\n')
              else if (m.type === 'exit') handleEnded()
            }
            ws.onclose = () => handleEnded()
            ws.onerror = () => {}
            function sendResize() {
              if (ws && ws.readyState === WebSocket.OPEN && term) {
                ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
              }
            }
            term.onData((d) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: d })) })
            term.onResize(({ cols, rows }) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })) })
          } catch (e) {
            if (disposed) return
            setStatus('error')
            return
          }
        }
        boot()
        return () => {
          disposed = true
          if (scrollCleanup) { try { scrollCleanup() } catch { /* 忽略 */ } }
          if (ws) { try { ws.send(JSON.stringify({ type: 'kill' })) } catch {} ; try { ws.close() } catch {} }
          if (term) { try { term.dispose() } catch {} }
          termRef.current = null
          fitRef.current = null
          wsRef.current = null
        }
      }, [])

      // 主题切换：重新应用 xterm 配色（不动已连接会话）
      useEffect(() => {
        const term = termRef.current
        if (term) term.options.theme = buildTermTheme(palette)
      }, [palette])

      // 切换到本标签页时（尺寸变为有效）re-fit + 聚焦（方案 B：打开/切换即接管键盘）。
      // 隐藏标签页尺寸为 0 不触发；**隐藏会话的面板**（display:none）同样跳过，
      // 否则会在别的会话里 fit 出 0 尺寸并向 PTY 回传错的 cols/rows、还抢走焦点。
      useEffect(() => {
        if (!active) return
        const fit = fitRef.current
        const term = termRef.current
        if (!fit || !term) return
        const raf = requestAnimationFrame(() => {
          const el = containerRef.current
          if (!el || !el.clientWidth || !el.clientHeight) return
          try { fit.fit() } catch { /* 忽略 */ }
          try { term.focus() } catch { /* 忽略 */ }
        })
        return () => cancelAnimationFrame(raf)
      }, [active])

      // 容器尺寸变化时 re-fit 并回传 resize；顺带聚焦（含挂起恢复）。
      useEffect(() => {
        const el = containerRef.current
        if (!el) return
        const ro = new ResizeObserver(() => {
          // 面板被隐藏（挂起 / 非当前会话）时尺寸为 0：既不 fit 也不抢焦点；
          // 重新显示时尺寸恢复，本观察器会再次触发。
          if (!el.clientWidth || !el.clientHeight) return
          const fit = fitRef.current
          const term = termRef.current
          if (fit && term) { try { fit.fit() } catch { /* 忽略 */ } }
          if (term) { try { term.focus() } catch { /* 忽略 */ } }
        })
        ro.observe(el)
        return () => ro.disconnect()
      }, [])

      return React.createElement('div', { ref: containerRef, style: { position: 'absolute', inset: 0, padding: '2px 4px 4px' } })
    }

    // 触摸类设备（无 hover）判定：这类设备看不到「悬停显形」，把手必须常驻淡显。
    // 失败一律当 false（鼠标端），行为与旧版一致。
    function prefersNoHover() {
      try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(hover: none)').matches
      } catch {
        return false
      }
    }

    // 铺满 / 还原图标：四角括号，向外=铺满、向内=还原（纯 SVG，不依赖字体字形）。
    function MaximizeIcon(restore) {
      const paths = restore
        ? ['M1 4h3V1', 'M11 4H8V1', 'M11 8H8v3', 'M1 8h3v3']
        : ['M1 4V1h3', 'M8 1h3v3', 'M11 8v3H8', 'M4 11H1V8']
      return React.createElement('svg', {
        width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', style: { display: 'block' },
      }, paths.map((d, i) => React.createElement('path', { key: i, d })))
    }

    // --- 终端面板（shell.overlay entry，弹出态） ------------------------------
    // 一个会话一个面板实例：每个实例持有自己的标签集合（切会话只隐藏，不销毁）。
    // 每个标签 = 一个独立 xterm + WebSocket + 宿主 PTY 会话；切标签不销毁会话
    // （其他标签容器隐藏但保持挂载），活动标签 re-fit。
    function TerminalPanel(props) {
      const { H, metrics, palette, onResize, onMinimize, onClose, hidden, getCwd, maximized, onToggleMaximize } = props

      // 读一次「本面板所属会话」的 cwd（容错：getCwd 缺失/抛错都当作「无」）。用 ref 读取，
      // 避免把 getCwd 的 props 身份变化牵连进各 useCallback 依赖。
      // 必须声明在下面的 useState 之前：首个标签的 state 初始化器会立刻调用 readCwd()，
      // 否则 getCwdRef 还在 TDZ，异常被 try/catch 吞掉 → 首个标签永远拿不到 cwd。
      const getCwdRef = useRef(getCwd)
      getCwdRef.current = getCwd
      function readCwd() {
        try {
          const g = getCwdRef.current
          return typeof g === 'function' ? g() : undefined
        } catch { return undefined }
      }

      // 每个标签在「创建那一刻」冻结当前会话的工作目录：会话切换只影响之后新建的
      // 标签，已在跑的 shell 不会被搬走（shell 的 cwd 只能由用户自己 cd 改变）。
      const [tabs, setTabs] = useState(() => [{ id: 1, num: 1, title: 'Terminal 1', cwd: readCwd() }])
      const [activeId, setActiveId] = useState(1)
      const nextIdRef = useRef(2)

      // 取当前空闲的最小正数作为新标签编号（关闭后复用，而不是一直递增）。
      const nextNum = useCallback((list) => {
        const used = new Set(list.map((x) => x.num))
        let n = 1
        while (used.has(n)) n++
        return n
      }, [])

      const onPointerDown = useCallback((e) => {
        e.preventDefault()
        const startY = e.clientY
        const startH = H
        let moved = false
        setBarActive(true)
        const onMove = (ev) => {
          // 位移 ≤5px 视为轻点；超过才算「拖动调整高度」。
          if (!moved && Math.abs(ev.clientY - startY) <= 5) return
          moved = true
          const newH = startH + (startY - ev.clientY)
          const clamped = Math.min(TERM_MAX_H, Math.max(TERM_MIN_H, Math.round(newH)))
          onResize(clamped)
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setBarActive(false)
          // 未发生拖动（点击/轻点）→ 收起终端（等同 −，保留会话）。
          if (!moved) onMinimize()
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [H, onResize, onMinimize])

      const addTab = useCallback(() => {
        const id = nextIdRef.current++
        const cwd = readCwd()
        // 注意：updater 形参不能叫 "t"，否则会遮蔽 i18n 的 t()，t('title') 会调数组导致报错。
        setTabs((prev) => {
          const num = nextNum(prev)
          return [...prev, { id, num, title: 'Terminal ' + num, cwd }]
        })
        setActiveId(id)
      }, [nextNum])

      // Host 回报真正生效的起始目录（可能是回退到 $HOME），写回标签用于悬停提示。
      const handleReady = useCallback((id, cwd) => {
        if (typeof cwd !== 'string' || !cwd) return
        setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, cwd } : x)))
      }, [])

      const closeTab = useCallback((id) => {
        const idx = tabs.findIndex((x) => x.id === id)
        if (idx < 0 || tabs.length === 1) return
        const next = tabs.filter((x) => x.id !== id)
        setTabs(next)
        if (id === activeId) {
          const ni = Math.min(idx, next.length - 1)
          setActiveId(next[ni] ? next[ni].id : -1)
        }
      }, [tabs, activeId])

      // 会话结束（Ctrl+D / exit / 连接断开）：移除该标签；若已是最后一个，则关闭整个面板。
      const handleExit = useCallback((id) => {
        const idx = tabs.findIndex((x) => x.id === id)
        if (idx < 0) return
        const next = tabs.filter((x) => x.id !== id)
        setTabs(next)
        if (next.length === 0) {
          onClose()
        } else if (id === activeId) {
          const ni = Math.min(idx, next.length - 1)
          setActiveId(next[ni] ? next[ni].id : -1)
        }
      }, [tabs, activeId, onClose])

      const tabbarStyle = {
        flex: 'none', height: 30, display: 'flex', alignItems: 'center', gap: 4,
        padding: '0 6px', borderBottom: '1px solid ' + palette.border, overflowX: 'auto', overflowY: 'hidden',
      }
      const tabStyle = (on) => ({
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 22, maxWidth: 160,
        padding: '0 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap', flex: 'none',
        background: on ? alpha(palette.accent, 0.16) : 'transparent',
        color: on ? palette.fg : palette.fg2,
        border: '1px solid ' + (on ? alpha(palette.accent, 0.5) : 'transparent'),
      })

      // --- 双击重命名标签标题 ------------------------------------------------
      const [editingId, setEditingId] = useState(null)
      const [editText, setEditText] = useState('')
      const editRef = useRef(null)

      // --- 顶部拖拽条的外观状态 ----------------------------------------------
      // noHover = 触摸类设备（没有 hover），把手需常驻淡显，否则细线无从发现。
      const [barHover, setBarHover] = useState(false)
      const [barActive, setBarActive] = useState(false)
      const [noHover] = useState(() => prefersNoHover())
      const barHot = barHover || barActive

      const startEdit = useCallback((id, current) => {
        setEditingId(id)
        setEditText(current)
      }, [])

      const commitEdit = useCallback(() => {
        const id = editingId
        const text = editText.trim()
        if (id !== null) {
          setTabs((prev) => prev.map((x) => (x.id === id ? { ...x, title: text || x.title } : x)))
        }
        setEditingId(null)
      }, [editingId, editText])

      const cancelEdit = useCallback(() => setEditingId(null), [])

      useEffect(() => {
        if (editingId !== null && editRef.current) {
          editRef.current.focus()
          editRef.current.select()
        }
      }, [editingId])

      return React.createElement('div', {
        style: {
          position: 'absolute',
          bottom: 0,
          left: metrics.sidebar,
          right: metrics.details,
          height: H,
          display: hidden ? 'none' : 'flex',
          flexDirection: 'column',
          background: palette.bg,
          // 边界线由顶部拖拽条那根 1px 细线承担（hover 时会变品牌色），
          // 所以这里**不再**加 borderTop，否则会叠成 2px。
          zIndex: 30,
          pointerEvents: 'auto',
          boxShadow: '0 -4px 18px rgba(0,0,0,.25)',
          overflow: 'hidden',
        },
      }, [
        // 顶部拖拽条：拖动=调整高度，点击（未拖动）=收起终端（等同 −）。
        // 视觉与命中区**解耦**（学官方 ui-layout 的 8px 隐形命中区）：
        //   静态 = 1px 细线（面板边界色，安静不吵）；
        //   鼠标进入 / 拖拽中 = 线亮成品牌色 + 中间把手浮出并加宽（可发现性）；
        //   纯触摸端没有 hover，故把手常驻淡显。
        // 命中区仍是 9px 高（比原来的 7px 条还大），并保留「点击收起」。
        React.createElement('div', {
          key: 'bar', onPointerDown: onPointerDown,
          onPointerEnter: () => setBarHover(true),
          onPointerLeave: () => setBarHover(false),
          title: lang() === 'en' ? 'Click to collapse · drag to resize' : '点击收起 · 拖动调整高度',
          'aria-label': t('minimize'),
          style: {
            flex: 'none', height: 9, position: 'relative', cursor: 'row-resize', touchAction: 'none',
            background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center',
          },
        }, [
          // 边界细线（静态只这一根；hover/拖拽时变品牌色）
          React.createElement('div', {
            key: 'line',
            style: {
              position: 'absolute', top: 0, left: 0, right: 0, height: 1,
              background: barHot ? alpha(palette.accent, 0.75) : palette.border,
              transition: 'background .15s ease',
            },
          }),
          // 抓握把手（静态几乎不可见，hover/拖拽时亮起并加宽）
          React.createElement('div', {
            key: 'grip',
            style: {
              width: barHot ? 56 : 42, height: 4, borderRadius: 999,
              background: alpha(palette.fg2, barHot ? 0.55 : (noHover ? 0.35 : 0.18)),
              transition: 'width .15s ease, background .15s ease',
            },
          }),
        ]),
        // 标签栏
        React.createElement('div', { key: 'tabs', style: tabbarStyle }, [
          ...tabs.map((tab) => React.createElement('div', {
            key: 'tab-' + tab.id, onClick: () => setActiveId(tab.id), title: editingId === tab.id ? undefined : (tab.cwd ? tab.title + '\n' + tab.cwd : tab.title), style: tabStyle(tab.id === activeId),
          }, [
            React.createElement('span', { key: 'label', style: { display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 } },
              React.createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: '#3fb950', display: 'inline-block', flex: 'none' } }),
              editingId === tab.id
                ? React.createElement('input', { ref: editRef, value: editText, onChange: (e) => setEditText(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); commitEdit() } else if (e.key === 'Escape') { e.stopPropagation(); cancelEdit() } },
                    onBlur: commitEdit,
                    onClick: (e) => e.stopPropagation(),
                    onDoubleClick: (e) => e.stopPropagation(),
                    style: {
                      width: 88, height: 20, padding: '0 6px', borderRadius: 4, border: '1px solid ' + alpha(palette.accent, 0.6),
                      background: alpha(palette.bg, 1), color: palette.fg, fontSize: 12, lineHeight: '18px', outline: 'none', boxSizing: 'border-box',
                    } })
                : React.createElement('span', { title: '双击重命名', onClick: (e) => e.stopPropagation(),
                    onDoubleClick: (e) => { e.stopPropagation(); startEdit(tab.id, tab.title) },
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' } }, tab.title)),
            React.createElement('button', { key: 'x', type: 'button', title: t('close'), onClick: (e) => { e.stopPropagation(); closeTab(tab.id) }, style: {
              border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 14, lineHeight: '16px', padding: '0 2px', opacity: 0.7, flex: 'none',
            } }, '×'),
          ])),
          React.createElement('button', { key: 'add', type: 'button', title: t('new'), onClick: addTab, style: {
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, flex: 'none',
            border: '1px dashed ' + palette.border, background: 'transparent', color: palette.fg2, cursor: 'pointer', fontSize: 14, lineHeight: '18px', padding: 0,
          } }, '+'),
          React.createElement('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          // 铺满 / 还原高度（复用同一份 H：铺满时 H = center 列可用高度，还原回到拖动前的高度）
          React.createElement('button', {
            key: 'maximize', type: 'button', onClick: onToggleMaximize,
            title: maximized ? t('restoreH') : t('maximize'),
            'aria-label': maximized ? t('restoreH') : t('maximize'),
            style: {
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', background: 'transparent', color: palette.fg2, cursor: 'pointer',
              padding: '0 4px', width: 22, height: 22, flex: 'none', marginLeft: 2,
            },
          }, maximized ? MaximizeIcon(true) : MaximizeIcon(false)),
          React.createElement('button', { key: 'minimize', type: 'button', onClick: onMinimize, title: t('minimize'), 'aria-label': t('minimize'), style: {
            border: 'none', background: 'transparent', color: palette.fg2, cursor: 'pointer', fontSize: 15, lineHeight: '18px', padding: '0 4px', flex: 'none', marginLeft: 2,
          } }, '−'),
          React.createElement('button', { key: 'close', type: 'button', onClick: onClose, title: t('close'), 'aria-label': t('close'), style: {
            border: 'none', background: 'transparent', color: palette.fg2, cursor: 'pointer', fontSize: 15, lineHeight: '18px', padding: '0 4px', flex: 'none', marginRight: 2,
          } }, '×'),
        ]),
        // 终端主体（各标签页叠放：活动页可见可交互，其余 visibility:hidden 但保持尺寸，切换不销毁会话）
        React.createElement('div', { key: 'body', style: { flex: '1 1 auto', minHeight: 0, position: 'relative', overflow: 'hidden' } },
          tabs.map((tab) => React.createElement('div', { key: tab.id, style: {
            position: 'absolute', inset: 0,
            visibility: tab.id === activeId ? 'visible' : 'hidden',
            zIndex: tab.id === activeId ? 1 : 0,
          } }, React.createElement(TerminalView, {
            palette,
            active: tab.id === activeId,
            cwd: tab.cwd,
            onReady: (cwd) => handleReady(tab.id, cwd),
            onExit: () => handleExit(tab.id),
          })))),
      ])
    }

    // --- 打开终端把手（对话区底部，iOS App Switcher / 主屏指示条风格） --------
    // 把原先的 ❯_ 芯片改成 iOS 那根「透明的横杠」：一段居中、半透明的圆角短杠，
    // 呼出方式为「上滑」（或轻点 / 回车）。挂起（minimized）时用品牌色点亮，
    // 提示这是「恢复」而不是「新开」。
    // 为避免挡住对话区底部的 dsh 输出统计：底部常驻 HANDLE_STRIP_H 横条放把手，
    // 把手 3 秒无操作自动淡出（同滚动条逻辑），光标靠近底部时重新亮起。
    function FloatOpenButton(props) {
      const { metrics, palette, onClick, minimized } = props
      const [visible, setVisible] = useState(true)
      const [hovered, setHovered] = useState(false)
      const [pressed, setPressed] = useState(false)
      const down = useRef(null)
      const hideTimer = useRef(null)

      // 亮起并把隐藏计时重置为 3 秒。
      const wake = useCallback(() => {
        if (hideTimer.current) clearTimeout(hideTimer.current)
        setVisible(true)
        hideTimer.current = setTimeout(() => setVisible(false), 3000)
      }, [])

      // 挂载即亮起一次，随后让 3 秒计时把它淡下去；卸载时清掉计时器。
      useEffect(() => {
        wake()
        return () => { if (hideTimer.current) clearTimeout(hideTimer.current) }
      }, [wake])

      // 光标靠近 frame 底部时重新亮起（让把手可被再次发现）。
      useEffect(() => {
        const frame = getFrame()
        if (!frame) return
        const onMove = (e) => {
          const rect = frame.getBoundingClientRect()
          if (e.clientY >= rect.bottom - 56 && e.clientY <= rect.bottom + 8) wake()
        }
        window.addEventListener('pointermove', onMove, { passive: true })
        return () => window.removeEventListener('pointermove', onMove)
      }, [wake])

      const onPointerDown = useCallback((e) => {
        down.current = { y: e.clientY }
        setPressed(true)
        wake()
        // 捕获指针，让「上滑」期间手指/光标移出把手后仍能收到 pointerup。
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 忽略 */ }
      }, [wake])

      const onPointerUp = useCallback((e) => {
        const d = down.current
        down.current = null
        setPressed(false)
        if (!d) return
        const dy = (e.clientY != null ? e.clientY : d.y) - d.y
        // 上滑超过阈值，或基本原位（轻点）都呼出终端；往下拖不触发，避免误触。
        if (dy < -16 || Math.abs(dy) <= 6) onClick()
      }, [onClick])

      const onPointerCancel = useCallback(() => {
        down.current = null
        setPressed(false)
      }, [])

      const onKey = useCallback((e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() }
      }, [onClick])

      // 半透明横杠：普通态用次级文字色压暗（随主题明暗），挂起态用品牌色点亮。
      const handleBg = minimized
        ? alpha(palette.accent, hovered ? 0.85 : 0.72)
        : alpha(palette.fg2, hovered ? 0.6 : 0.42)

      return React.createElement('div', {
        style: {
          position: 'absolute',
          left: metrics.sidebar,
          right: metrics.details,
          bottom: 2, // iOS 式：离屏幕底边约 2px
          zIndex: 30,
          pointerEvents: 'none', // 只做定位/居中，不拦截底下对话内容
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 5,
          opacity: visible ? 1 : 0,
          transition: 'opacity .3s ease',
        },
      }, React.createElement('div', {
        role: 'button',
        tabIndex: 0,
        title: minimized ? t('restore') : t('open'),
        'aria-label': minimized ? t('restore') : t('open'),
        onPointerDown,
        onPointerUp,
        onPointerCancel,
        onPointerEnter: () => { setHovered(true); wake() },
        onPointerLeave: () => setHovered(false),
        onKeyDown: onKey,
        style: {
          pointerEvents: visible ? 'auto' : 'none', // 隐藏时不再拦截底下内容
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 156,
          height: 5,
          cursor: 'pointer',
          touchAction: 'none', // 让触摸端的「上滑」交给指针事件，而不是页面滚动
          outline: 'none',
        },
      }, React.createElement('div', {
        style: {
          width: pressed ? 168 : 148,   // 按下时稍微拉宽，提示「可上拉」
          height: 5,
          borderRadius: 999,
          background: handleBg,
          transition: 'width .12s ease, background .16s ease',
        },
      })))
    }

    // --- React 错误边界（防止单个渲染错误把整个 overlay 入口摘掉） ------------
    class TerminalErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error, info) {
        const msg = (error && error.stack ? error.stack : String(error)) + '\n' + ((info && info.componentStack) || '')
        try { this.props.onReport && this.props.onReport(msg) } catch { /* 忽略 */ }
      }
      render() {
        if (this.state.error) {
          return React.createElement('div', { style: {
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 8,
            fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #e5484d)', padding: 16, textAlign: 'center',
          } }, [
            React.createElement('div', null, '终端渲染出错'),
            React.createElement('div', { style: { fontFamily: 'monospace', fontSize: 11, color: 'var(--dsw-alias-label-secondary, #8a8a8e)', maxHeight: '70%', overflow: 'auto' } }, String(this.state.error && this.state.error.message || this.state.error)),
            React.createElement('button', { type: 'button', onClick: () => this.setState({ error: null }), style: {
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))', background: 'transparent',
              color: 'inherit', fontSize: 12, padding: '4px 12px', borderRadius: 8, cursor: 'pointer',
            } }, '重试'),
          ])
        }
        return this.props.children
      }
    }

    // --- shell.overlay 入口 --------------------------------------------------
    // 面板状态：mounted=至少有一个会话的面板挂载着（保留各标签会话）；shown=面板可见。
    //  - 打开：mounted+shown
    //  - 挂起(−)：shown=false（隐藏但保留全部会话，输出继续写入 xterm）
    //  - 关闭(×)：mounted=false+keys=[]（卸载全部门板，杀死所有会话）
    // 每会话一套标签：keys = 已登记面板的会话 key，只有当前会话那套可见。
    // 切会话不销毁别套（display:none 但组件仍挂载 → WS 与 PTY 都活着），切回来原样恢复。
    function TerminalOverlay(props) {
      const { getCwdFor, sessionKey, subscribe } = props
      const { metrics } = useFrameMetrics()
      const palette = useAppPalette()
      const [mounted, setMounted] = useState(false)
      const [shown, setShown] = useState(false)
      const [H, setH] = useState(TERM_DEFAULT_H)
      const [maximized, setMaximized] = useState(false)
      const [keys, setKeys] = useState([])
      const restoreHRef = useRef(TERM_DEFAULT_H)

      const activeKey = useSessionKey(sessionKey, subscribe)

      const ensureKey = useCallback((key) => {
        setKeys((prev) => (prev.indexOf(key) >= 0 ? prev : [...prev, key]))
      }, [])

      // 面板打开/可见期间，保证「当前会话」有一套自己的标签面板（首次访问该会话时新建
      // 一个终端，落在它的工作目录里）。
      useEffect(() => {
        if (mounted && shown) ensureKey(activeKey)
      }, [mounted, shown, activeKey, ensureKey])

      // 收起态常驻预留 HANDLE_STRIP_H 横条（不遮输出统计，统一预留也没有显隐跳动）；
      // 终端展开时改用面板高度 H 压缩对话区。
      useEffect(() => {
        const frame = getFrame()
        const center = getCenterCol(frame)
        if (!center) return
        center.style.paddingBottom = (shown ? H : HANDLE_STRIP_H) + 'px'
        return () => { center.style.paddingBottom = '' }
      }, [shown, H])

      // 打开时同一次提交里就登记当前会话，避免先渲染出「空的」面板区域再补上。
      const openPanel = useCallback(() => {
        setMounted(true)
        setShown(true)
        ensureKey(activeKey)
      }, [ensureKey, activeKey])
      const minimize = useCallback(() => { setShown(false) }, [])
      const closePanel = useCallback(() => { setMounted(false); setShown(false); setKeys([]) }, [])

      // 手动拖高度视为放弃「铺满」态；铺满时 H = center 列可用高度。
      const resize = useCallback((h) => { setMaximized(false); setH(h) }, [])
      const toggleMaximize = useCallback(() => {
        if (maximized) {
          setH(restoreHRef.current || TERM_DEFAULT_H)
          setMaximized(false)
          return
        }
        const frame = getFrame()
        const avail = frame && frame.clientHeight
          ? frame.clientHeight
          : (typeof window !== 'undefined' ? window.innerHeight : TERM_MAX_H)
        restoreHRef.current = H
        setH(Math.max(TERM_MIN_H, Math.round(avail - 2)))
        setMaximized(true)
      }, [maximized, H])

      return React.createElement(React.Fragment, null,
        // 底部把手只在终端收起/未打开时显示：点击/上滑 = 打开。
        !shown ? React.createElement(FloatOpenButton, { metrics, palette, onClick: openPanel, minimized: mounted }) : null,
        mounted ? React.createElement(TerminalErrorBoundary, {
          onReport: (m) => reportError('ENTRY_ERROR', m),
        }, keys.map((key) => React.createElement(TerminalPanel, {
          key,
          H: H >= TERM_MIN_H ? H : TERM_DEFAULT_H,
          metrics,
          palette,
          onResize: resize,
          onMinimize: minimize,
          onClose: closePanel,
          hidden: !shown || key !== activeKey,
          // 每个面板绑到**自己那个会话**的 cwd：后台面板里按 + 新建标签时，
          // 用的仍是该会话的目录，而不是此刻选中的会话。
          getCwd: () => getCwdFor(key),
          maximized,
          onToggleMaximize: toggleMaximize,
        }))) : null)
    }

    // --- apply ------------------------------------------------------------------
    function apply(ctx) {
      // 三个稳定回调：会话变化靠订阅触发换套；cwd 按「传入的会话 key」读，
      // 保证后台面板新建标签也用对它自己的会话目录。
      const getCwdFor = (key) => {
        const current = readSession(ctx)
        if (!key || key === NO_SESSION_KEY || current.id === key) return current.cwd
        return readSession(ctx, key).cwd
      }
      const sessionKey = () => readSession(ctx).id || NO_SESSION_KEY
      const subscribe = (fn) => subscribeSessions(ctx, fn)
      const Entry = () => React.createElement(TerminalOverlay, { getCwdFor, sessionKey, subscribe })
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: OVERLAY_ID,
        order: 40,
      }, Entry))
    }

    return { apply, inject: ['slots'] }
  },
})
