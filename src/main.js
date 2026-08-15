'use strict'

/**
 * DeepSeek Harness 桌面客户端 —— 主进程
 *
 * 行为：
 *  1. 探测 http://<host>:<port> 上是否已有 dsh web 服务（页面含 "DeepSeek Harness" 标记）：
 *     有 → 直连（external 模式）；
 *     无 → 自动拉起 `dsh web --host <host> --port <port>` 并管理其生命周期（managed 模式）。
 *  2. 启动画面（splash.html）展示连接/启动进度与服务日志，支持换端口重试。
 *  3. 服务就绪后在同一窗口加载 DeepSeek Harness 界面。
 *  4. 退出应用时默认结束由本应用拉起的服务进程树（启动画面可勾选保留）。
 *
 * 参数 / 环境变量：
 *   --port <n>        服务端口（默认 3080；环境变量 DSH_PORT 亦可）
 *   --host <h>        绑定主机（默认 127.0.0.1；环境变量 DSH_HOST 亦可）
 *   --no-server       只连接不拉起服务
 *   --dsh-cli <path>  指定 dsh 命令（.cmd 或 bin.js）路径
 *   --smoke-test      冒烟测试：连接成功即打印 SMOKE-OK 并退出
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron')
const { spawn, execFile, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const usageSvc = require('./usage.js')

const PRODUCT_NAME = 'DeepSeek Harness Desktop'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const PAGE_MARKER = 'DeepSeek Harness'
const STARTUP_TIMEOUT_MS = 90 * 1000
const POLL_INTERVAL_MS = 700
const HEALTH_CHECK_MS = 25 * 1000

// 用户数据目录固定为 %APPDATA%\DeepSeekHarnessDesktop（窗口位置、端口记忆、日志）
app.setPath('userData', path.join(app.getPath('appData'), 'DeepSeekHarnessDesktop'))

/* ---------------- 参数与配置 ---------------- */

function parseArgs(argv) {
  const o = { port: null, host: null, noServer: false, smoke: false, dshCli: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--port=')) o.port = Number(a.slice('--port='.length))
    else if (a === '--port') { o.port = Number(argv[i + 1]); i++ }
    else if (a.startsWith('--host=')) o.host = a.slice('--host='.length)
    else if (a === '--host') { o.host = argv[i + 1]; i++ }
    else if (a.startsWith('--dsh-cli=')) o.dshCli = a.slice('--dsh-cli='.length)
    else if (a === '--dsh-cli') { o.dshCli = argv[i + 1]; i++ }
    else if (a === '--no-server') o.noServer = true
    else if (a === '--smoke-test') o.smoke = true
  }
  return o
}

const args = parseArgs(process.argv.slice(1))
// Electron 开发模式下 process.argv 形如 [electron, ., --port, 3090]，slice(1) 覆盖两种情况
if (process.argv[1] === '.') Object.assign(args, parseArgs(process.argv.slice(2)))

let settings = {}
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {} } catch { settings = {} }
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  } catch { /* 非致命 */ }
}

let config = null

/* ---------------- 日志 ---------------- */

let logPath = ''
let logStream = null
function initLog() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    logPath = path.join(dir, 'server.log')
    if (fs.statSync(logPath).size > 5 * 1024 * 1024) {
      try { fs.unlinkSync(logPath + '.old') } catch { }
      fs.renameSync(logPath, logPath + '.old')
    }
    logStream = fs.createWriteStream(logPath, { flags: 'a' })
  } catch {
    // 用户数据目录不可写时（如受限环境）降级为不落盘，仅转发到启动画面
    logPath = ''
    logStream = null
  }
}

function openLogTarget() {
  if (logPath && fs.existsSync(logPath)) return logPath
  if (logPath) return path.dirname(logPath)
  return app.getPath('userData')
}

function logLine(text) {
  const line = `[${new Date().toISOString()}] ${String(text)}`
  try { if (logStream) logStream.write(line + '\n') } catch { }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', line)
  }
}

/* ---------------- 窗口与状态 ---------------- */

let mainWindow = null
let phase = 'idle'
let stateDetail = ''
let mode = 'external' // external: 连接已有服务; managed: 本应用拉起的服务
let serverProc = null
let dshCli = null
let generation = 0
let quitting = false
let smokeDone = false
let healthTimer = null
let started = false

function baseUrl() {
  return `http://${config.host}:${config.port}`
}

function iconPath() {
  const p = path.join(__dirname, '..', 'build', 'icon.png')
  return fs.existsSync(p) ? p : undefined
}

function stateSnapshot() {
  return {
    phase,
    detail: stateDetail,
    mode,
    url: baseUrl(),
    host: config.host,
    port: config.port,
    keepServer: settings.keepServerOnQuit === true,
    logPath: logPath || '',
    smoke: args.smoke,
    productName: PRODUCT_NAME
  }
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state', stateSnapshot())
  }
}

function smokeExit(code) {
  if (smokeDone) return
  smokeDone = true
  setTimeout(() => app.exit(code), 300)
}

// 冒烟测试扩展：shell 与 iframe 就绪后，采集一次余额与用量并验证 UI（不参与退出码判定）
async function finishSmokeWithUsage() {
  await Promise.race([
    Promise.allSettled([usageSvc.refreshUsage(usageCfg().prices), usageSvc.refreshBalance(usageCfg())]),
    new Promise((r) => setTimeout(r, 25000))
  ])
  const { balance, usage } = usageSvc.getSnapshot()
  const balanceOk = balance ? String(balance.ok) : 'n/a'
  const usageSessions = usage ? String(usage.sessionCount) : 'n/a'
  const todayRequests = usage ? String(usage.today.requests) : 'n/a'
  console.log(`SMOKE-USAGE balanceOk=${balanceOk} usageSessions=${usageSessions} todayRequests=${todayRequests}`)
  let widget = 'n/a'
  let dash = 'n/a'
  let chart = 'n/a'
  let frame = 'n/a'
  let logoOk = 'n/a'
  let welcomeOk = 'n/a'
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 浮窗：必须「可见 + 有真实余额文本 + 未被 iframe 遮挡」
      widget = String(await mainWindow.webContents.executeJavaScript(`(() => {
        const root = document.getElementById('dshd-root')
        if (!root) return 'missing'
        if (root.classList.contains('hidden')) return 'hidden'
        const pill = document.getElementById('dshd-pill')
        if (!pill) return 'no-pill'
        const rc = pill.getBoundingClientRect()
        if (rc.width < 1 || rc.height < 1) return 'zero-size'
        const top = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2)
        const covered = top && top !== pill && !pill.contains(top)
        const txt = (document.getElementById('dshd-pill-text') || {}).textContent || ''
        return (covered ? 'covered:' + (top.tagName || '?') : 'visible') + ' text=' + txt
      })()`))
      const dashText = await mainWindow.webContents.executeJavaScript(
        '(document.getElementById("dash-month-tokens")||{}).textContent || ""')
      dash = dashText && dashText.trim() ? 'ok' : 'missing'
      const rectCount = await mainWindow.webContents.executeJavaScript(
        'document.querySelectorAll("#dash-chart svg rect[data-i]").length')
      chart = Number(rectCount) > 0 ? 'ok' : 'missing'
      const frames = mainWindow.webContents.mainFrame ? mainWindow.webContents.mainFrame.frames : []
      frame = frames.some((f) => f.url.startsWith(baseUrl())) ? 'ok' : 'missing'
      const logo = await mainWindow.webContents.executeJavaScript(
        '(function(){var i=document.querySelector(".brand img");return i && i.naturalWidth>0 ? "ok" : "missing"})()')
      logoOk = String(logo)
      const welcome = await mainWindow.webContents.executeJavaScript(
        '(function(){var p=(document.getElementById("welcome-poem")||{}).textContent||"";var v=(document.getElementById("dash-version")||{}).textContent||"";return (p.trim()&&p.trim()!=="--"?"poem-ok":"poem-missing")+"/"+(/^v/.test(v)?"ver-ok":"ver-missing")})()')
      welcomeOk = String(welcome)
    }
  } catch {
    widget = 'error'
    dash = 'error'
    chart = 'error'
    frame = 'error'
    logoOk = 'error'
    welcomeOk = 'error'
  }
  console.log(`SMOKE-WIDGET ${widget}`)
  console.log(`SMOKE-DASH ${dash}`)
  console.log(`SMOKE-CHART ${chart}`)
  console.log(`SMOKE-FRAME ${frame}`)
  console.log(`SMOKE-LOGO ${logoOk}`)
  console.log(`SMOKE-WELCOME ${welcomeOk}`)

  // 设置窗口：打开 → 等待加载 → 验证表单元素 → 关闭
  let settingsOk = 'n/a'
  try {
    openSettingsWindow()
    if (settingsWin) {
      await Promise.race([
        new Promise((resolve) => settingsWin.webContents.once('did-finish-load', () => resolve())),
        new Promise((r) => setTimeout(r, 8000))
      ])
      await sleep(1000)
      const present = await settingsWin.webContents.executeJavaScript(
        'document.getElementById("enabled") ? "ok" : "missing"')
      settingsOk = String(present)
      settingsWin.close()
    }
  } catch {
    settingsOk = 'error'
  }
  console.log(`SMOKE-SETTINGS ${settingsOk}`)
  smokeExit(0)
}

function setPhase(p, detail) {
  phase = p
  stateDetail = detail || ''
  if (args.smoke && p === 'error') {
    console.log(`SMOKE-FAIL ${stateDetail}`)
    smokeExit(1)
  }
  broadcast()
}

function showSplash() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const url = mainWindow.webContents.getURL()
  if (!url.startsWith('file:')) {
    mainWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => { })
  }
}

function createWindow() {
  const b = settings.windowBounds || {}
  mainWindow = new BrowserWindow({
    width: b.width || 1440,
    height: b.height || 900,
    x: b.x,
    y: b.y,
    minWidth: 1024,
    minHeight: 680,
    show: !args.smoke,
    backgroundColor: '#f4f5f0',
    autoHideMenuBar: true,
    title: PRODUCT_NAME,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'splash.html'))

  mainWindow.on('close', (e) => {
    try {
      settings.windowBounds = mainWindow.getBounds()
      saveSettings()
    } catch { }
    if (settings.confirmOnQuit === true && !quitting) {
      e.preventDefault()
      const keepNote = mode === 'managed' && settings.keepServerOnQuit !== true
        ? '\n退出时将一并关闭由本应用拉起的本地服务。'
        : ''
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: '退出',
        message: '确定要退出 DeepSeek Harness 吗？',
        detail: `余额与用量面板会随应用关闭。${keepNote}`,
        buttons: ['退出', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }).then(({ response }) => {
        if (response === 0) {
          quitting = true
          app.quit()
        }
      }).catch(() => { })
      return
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  const handleNewWindow = ({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(baseUrl() + '/') && url !== baseUrl()) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  }
  mainWindow.webContents.setWindowOpenHandler(handleNewWindow)

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code !== -3 && url.startsWith('file:')) {
      setPhase('error', `界面加载失败（${desc}）`)
      showSplash()
    }
  })

  mainWindow.once('ready-to-show', () => { if (!args.smoke) mainWindow.show() })
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(baseUrl() + '/') && url !== baseUrl()) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })
})

/* ---------------- 服务探测与拉起 ---------------- */

function execP(file, argsList) {
  return new Promise((resolve, reject) => {
    execFile(file, argsList, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout || ''))
    })
  })
}

function probeUrl(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 2500 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 500) { res.resume(); resolve(null); return }
      let body = ''
      res.on('data', (c) => {
        body += c
        if (body.length > 300000) { req.destroy(); resolve(null) }
      })
      res.on('end', () => resolve(body))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

async function isDshUp() {
  const body = await probeUrl(config.host, config.port)
  return typeof body === 'string' && body.includes(PAGE_MARKER)
}

async function resolveDshCli(envHint) {
  const candidates = []
  if (envHint) candidates.push(envHint)
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'dsh.cmd'))
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm', 'dsh.cmd'))
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return { kind: 'cmd', path: c }
  }
  try {
    const out = await execP('where.exe', ['dsh'])
    const line = out.split(/\r?\n/).map((s) => s.trim())
      .find((l) => l && /\.(cmd|exe|bat)$/i.test(l))
    if (line && fs.existsSync(line)) return { kind: 'cmd', path: line }
  } catch { }
  // 兜底：用 Electron 内置 Node 直接运行 dsh 的 bin.js
  try {
    const npmRoot = (await execP('npm.cmd', ['root', '-g'])).trim()
    const binJs = path.join(npmRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(binJs)) return { kind: 'binjs', path: binJs }
  } catch { }
  return null
}

function spawnServer() {
  const argsList = ['web', '--host', config.host, '--port', String(config.port)]
  const baseEnv = { ...process.env }
  if (dshCli.kind === 'cmd') {
    serverProc = spawn(dshCli.path, argsList, {
      shell: true,
      windowsHide: true,
      cwd: os.homedir(),
      env: baseEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } else {
    serverProc = spawn(process.execPath, [dshCli.path, ...argsList], {
      windowsHide: true,
      cwd: os.homedir(),
      env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }

  const attach = (stream) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      String(chunk).split(/\r?\n/).filter((l) => l.trim()).forEach(logLine)
    })
  }
  attach(serverProc.stdout)
  attach(serverProc.stderr)

  serverProc.on('error', (err) => {
    logLine(`服务进程启动失败：${err.message}`)
    serverProc = null
    if (!quitting) setPhase('error', `无法启动本地服务：${err.message}`)
  })

  serverProc.on('exit', (code, signal) => {
    logLine(`服务进程已退出（code=${code} signal=${signal ?? ''}）`)
    serverProc = null
    if (quitting) return
    if (phase === 'ready') {
      // shell 会展示错误覆盖层与重试按钮，无需回退启动画面
      setPhase('stopped', '本地服务已停止')
    } else {
      setPhase('error', `本地服务启动失败（退出码 ${code}）。请展开下方日志查看原因。`)
    }
  })
}

function killServerTree() {
  const p = serverProc
  serverProc = null
  if (!p) return
  try {
    execFileSync('taskkill.exe', ['/pid', String(p.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000, stdio: 'ignore' })
  } catch { }
  try { p.kill() } catch { }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function finishReady(gen, newMode) {
  if (gen !== generation || !mainWindow || mainWindow.isDestroyed()) return
  mode = newMode
  setPhase('ready', '服务就绪，正在加载界面 …')
  // 服务就绪后加载应用外壳（顶栏 + 仪表盘/工作台），Harness 页面由外壳内的 iframe 承载
  mainWindow.loadFile(path.join(__dirname, 'shell.html')).catch(() => { })
}

async function beginConnect() {
  const gen = ++generation
  setPhase('connecting', `正在连接 ${baseUrl()} …`)
  const up = await isDshUp()
  if (gen !== generation) return
  if (up) { await finishReady(gen, 'external'); return }
  if (args.noServer) {
    setPhase('error', `未检测到运行中的 DeepSeek Harness 服务（${baseUrl()}），且本次已指定 --no-server。`)
    return
  }
  await beginManaged(gen)
}

async function beginManaged(gen) {
  if (gen !== generation) return
  setPhase('starting', `未检测到服务，正在启动本地 DeepSeek Harness …`)
  logLine(`启动本地服务: dsh web --host ${config.host} --port ${config.port}`)
  if (!dshCli) dshCli = await resolveDshCli(args.dshCli)
  if (gen !== generation) return
  if (!dshCli) {
    setPhase('error', '未找到 dsh 命令行工具。请先安装：npm install -g @deepseek-ai/dsh，然后点击“重试”。')
    return
  }
  spawnServer()
  await pollUntilReady(gen)
}

async function pollUntilReady(gen) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (gen !== generation) return
    if (!serverProc) return // 退出处理器已接管
    if (await isDshUp()) { await finishReady(gen, 'managed'); return }
    await sleep(POLL_INTERVAL_MS)
  }
  if (gen !== generation) return
  setPhase('error', '服务启动超时（90 秒）。请展开下方日志查看详情，或点击“重试”。')
}

function startHealthCheck() {
  if (healthTimer) return
  healthTimer = setInterval(async () => {
    if (quitting || phase !== 'ready' || mode !== 'external') return
    const gen = generation
    if (!(await isDshUp()) && gen === generation && phase === 'ready') {
      setPhase('stopped', '本地服务已停止')
    }
  }, HEALTH_CHECK_MS)
}

/* ---------------- IPC ---------------- */

ipcMain.handle('splash:get-config', () => {
  if (!started) {
    started = true
    beginConnect().catch((err) => setPhase('error', `内部错误：${err.message}`))
  }
  return stateSnapshot()
})

ipcMain.handle('splash:retry', (_e, payload = {}) => {
  const p = Number(payload && payload.port)
  if (Number.isInteger(p) && p > 0 && p < 65536) {
    config.port = p
    settings.port = p
    saveSettings()
  }
  killServerTree()
  beginConnect().catch((err) => setPhase('error', `内部错误：${err.message}`))
  return true
})

ipcMain.handle('splash:open-browser', () => { shell.openExternal(baseUrl()); return true })
ipcMain.handle('splash:open-logs', () => {
  const target = logPath && fs.existsSync(logPath) ? logPath : path.dirname(logPath)
  shell.openPath(target)
  return true
})
ipcMain.handle('splash:set-keep-server', (_e, v) => {
  settings.keepServerOnQuit = v === true
  saveSettings()
  return true
})
ipcMain.handle('splash:quit', () => { app.quit(); return true })

/* ---------------- 余额与用量 ---------------- */

let settingsWin = null
let balanceTimer = null
let usageTimer = null

function usageCfg() {
  return settings.usageWidget || {}
}

function usageSettingsPayload() {
  return {
    enabled: usageCfg().enabled === true,
    refreshBalanceMs: usageCfg().refreshBalanceMs || 60000,
    prices: Object.assign({}, usageSvc.DEFAULT_PRICES, usageCfg().prices || {})
  }
}

function broadcastUsage(extra = {}) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('usage:update', {
      snapshot: usageSvc.getSnapshot(),
      settings: usageSettingsPayload(),
      ...extra
    })
  }
}

async function runBalanceRefresh() {
  await usageSvc.refreshBalance(usageCfg())
  broadcastUsage()
}

async function runUsageRefresh() {
  await usageSvc.refreshUsage(usageCfg().prices)
  broadcastUsage()
}

function startUsageTimers() {
  stopUsageTimers()
  balanceTimer = setInterval(() => { runBalanceRefresh().catch(() => { }) }, Math.max(15000, usageCfg().refreshBalanceMs || 60000))
  usageTimer = setInterval(() => { runUsageRefresh().catch(() => { }) }, Math.max(60000, usageCfg().refreshUsageMs || 300000))
}

function stopUsageTimers() {
  if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null }
  if (usageTimer) { clearInterval(usageTimer); usageTimer = null }
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 620,
    height: 820,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'DeepSeek Harness 设置',
    backgroundColor: '#f4f5f0',
    icon: iconPath(),
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  settingsWin.loadFile(path.join(__dirname, 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
}

ipcMain.handle('usage:get-snapshot', () => ({
  snapshot: usageSvc.getSnapshot(),
  settings: usageSettingsPayload()
}))

ipcMain.handle('usage:refresh', async () => {
  await Promise.allSettled([runBalanceRefresh(), runUsageRefresh()])
  return { snapshot: usageSvc.getSnapshot() }
})

ipcMain.handle('usage:get-settings', () => ({
  enabled: usageCfg().enabled === true,
  apiKeyOverrideSet: typeof usageCfg().apiKeyOverride === 'string' && usageCfg().apiKeyOverride.length > 0,
  hasDshKey: usageSvc.readCredentialKey() !== '',
  balanceUrl: usageCfg().balanceUrl || '',
  refreshBalanceMs: usageCfg().refreshBalanceMs || 60000,
  prices: Object.assign({}, usageSvc.DEFAULT_PRICES, usageCfg().prices || {}),
  confirmOnQuit: settings.confirmOnQuit === true,
  keepServerOnQuit: settings.keepServerOnQuit === true
}))

ipcMain.handle('usage:set-settings', (_e, v = {}) => {
  const w = usageCfg()
  if (typeof v.enabled === 'boolean') w.enabled = v.enabled
  if (typeof v.apiKeyOverride === 'string') w.apiKeyOverride = v.apiKeyOverride.trim()
  if (typeof v.balanceUrl === 'string') {
    const u = v.balanceUrl.trim()
    if (u === '' || /^https:\/\//i.test(u)) w.balanceUrl = u
  }
  const ms = Number(v.refreshBalanceMs)
  if (Number.isInteger(ms) && ms >= 15000 && ms <= 30 * 60 * 1000) w.refreshBalanceMs = ms
  if (v.prices && typeof v.prices === 'object') {
    w.prices = Object.assign({}, w.prices || {}, {
      input: Math.max(0, Number(v.prices.input) || 0),
      output: Math.max(0, Number(v.prices.output) || 0),
      cacheRead: Math.max(0, Number(v.prices.cacheRead) || 0),
      cacheWrite: Math.max(0, Number(v.prices.cacheWrite) || 0)
    })
  }
  if (typeof v.confirmOnQuit === 'boolean') settings.confirmOnQuit = v.confirmOnQuit
  if (typeof v.keepServerOnQuit === 'boolean') settings.keepServerOnQuit = v.keepServerOnQuit
  saveSettings()
  startUsageTimers()
  runBalanceRefresh().catch(() => { })
  runUsageRefresh().catch(() => { })
  broadcastUsage()
  return true
})

ipcMain.handle('usage:open-platform', () => { shell.openExternal(usageSvc.PLATFORM_USAGE_URL); return true })
ipcMain.handle('usage:open-settings', () => { openSettingsWindow(); return true })

/* ---------------- 应用外壳（顶栏 + 仪表盘/工作台） ---------------- */

let shellLoaded = false
let iframeOk = false

ipcMain.handle('shell:get-state', () => ({
  state: stateSnapshot(),
  usage: usageSettingsPayload(),
  version: app.getVersion()
}))

ipcMain.on('shell:loaded', () => {
  shellLoaded = true
  if (args.smoke) console.log('SMOKE-SHELL loaded')
})

ipcMain.on('shell:iframe-ok', () => {
  if (!iframeOk) iframeOk = true
  if (args.smoke && phase === 'ready' && !smokeDone) {
    console.log(`SMOKE-OK url=${baseUrl()} mode=${mode}`)
    finishSmokeWithUsage()
  }
})

/* ---------------- 菜单 ---------------- */

function buildMenu() {
  const tpl = [
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '仪表盘',
          accelerator: 'Ctrl+1',
          click: () => {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('shell:navigate', 'dashboard')
            }
          }
        },
        {
          label: '工作台',
          accelerator: 'Ctrl+2',
          click: () => {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('shell:navigate', 'workbench')
            }
          }
        },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        {
          label: '余额与用量面板',
          type: 'checkbox',
          checked: usageCfg().enabled === true,
          click: (item) => {
            usageCfg().enabled = item.checked === true
            saveSettings()
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('usage:visibility', item.checked)
            }
          }
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '立即刷新余额与用量',
          click: () => {
            runBalanceRefresh().catch(() => { })
            runUsageRefresh().catch(() => { })
          }
        },
        { label: '余额与用量设置', click: () => openSettingsWindow() },
        { type: 'separator' },
        { label: '在浏览器中打开', click: () => shell.openExternal(baseUrl()) },
        {
          label: '打开服务日志',
          click: () => {
            const target = logPath && fs.existsSync(logPath) ? logPath : path.dirname(logPath)
            shell.openPath(target)
          }
        },
        { type: 'separator' },
        {
          label: '关于',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: '关于',
            message: PRODUCT_NAME,
            detail: `本地服务地址：${baseUrl()}\n日志目录：${path.dirname(logPath)}`
          })
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl))
}

/* ---------------- 应用生命周期 ---------------- */

// 冒烟测试模式绕过单实例锁：不应与用户正在运行的真实实例抢锁
const gotLock = args.smoke ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.dsh.desktop')
    initLog()
    loadSettings()
    settings.usageWidget = Object.assign({
      enabled: true,
      apiKeyOverride: '',
      balanceUrl: '',
      refreshBalanceMs: 60 * 1000,
      refreshUsageMs: 5 * 60 * 1000,
      prices: Object.assign({}, usageSvc.DEFAULT_PRICES)
    }, settings.usageWidget || {})
    if (typeof settings.confirmOnQuit !== 'boolean') settings.confirmOnQuit = false

    const portCandidates = [args.port, Number(process.env.DSH_PORT), settings.port, DEFAULT_PORT]
    const port = portCandidates.find((p) => Number.isInteger(p) && p > 0 && p < 65536) || DEFAULT_PORT
    config = {
      host: args.host || process.env.DSH_HOST || settings.host || DEFAULT_HOST,
      port
    }

    buildMenu()
    createWindow()
    startHealthCheck()
    startUsageTimers()
    runBalanceRefresh().catch(() => { })
    runUsageRefresh().catch(() => { })

    if (args.smoke) {
      setTimeout(() => {
        console.log('SMOKE-FAIL timeout')
        smokeExit(2)
      }, 120000)
    }
  })

  app.on('before-quit', () => {
    quitting = true
    if (settings.keepServerOnQuit !== true) killServerTree()
  })

  app.on('window-all-closed', () => app.quit())
}
