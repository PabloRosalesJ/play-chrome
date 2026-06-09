const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const net = require('net')
const { WebSocketServer } = require('ws')
const { chromium } = require('playwright-core')

const PORT = parseInt(process.env.PORT || '3000', 10)
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10)
const CONSOLE_DELAY = 80
const CDP_TIMEOUT = 8000

const OS_CONFIGS = {
  mac: {
    chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    chromeDir: path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome')
  },
  linux: {
    chromePath: '/usr/bin/google-chrome',
    chromeDir: path.join(process.env.HOME || '', '.config', 'google-chrome')
  },
  win: {
    chromePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    chromeDir: path.join(process.env.HOME || process.env.USERPROFILE || '', 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  }
}

function parseArgs() {
  const args = process.argv.slice(2)
  let os = 'mac'
  let profile = null
  let profilesOnly = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--os' && i + 1 < args.length) os = args[++i]
    if (args[i] === '--profile' && i + 1 < args.length) profile = args[++i]
    if (args[i] === '--profiles') profilesOnly = true
  }
  if (!OS_CONFIGS[os]) {
    console.error('Unsupported OS: ' + os + '. Supported: mac, linux, win')
    process.exit(1)
  }
  return { os, profile, profilesOnly, config: OS_CONFIGS[os] }
}

const CLI = parseArgs()
const CHROME_PATH = CLI.config.chromePath
const CHROME_DIR = CLI.config.chromeDir
const PLAYCHROME_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.playchrome')

let browser = null
let activePage = null
let chromeProcess = null
const wsClients = new Set()

function cleanError(msg) {
  return String(msg).replace(/\u001b\[[0-9;]*m/g, '').trim()
}

function isPortOpen(port) {
  return new Promise(resolve => {
    const sock = net.createConnection(port, '127.0.0.1')
    sock.on('connect', () => { sock.destroy(); resolve(true) })
    sock.on('error', () => resolve(false))
  })
}

function getProfiles() {
  const profiles = []
  if (!fs.existsSync(CHROME_DIR)) return profiles
  const dirs = fs.readdirSync(CHROME_DIR, { withFileTypes: true })
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const name = d.name
    if (name === 'Guest Profile' || name === 'System Profile') continue
    if (!name.match(/^(Default|Profile \d+)$/)) continue
    const prefsPath = path.join(CHROME_DIR, name, 'Preferences')
    let displayName = name
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'))
      if (prefs.profile?.name) displayName = prefs.profile.name
    } catch {}
    profiles.push({ dir: name, name: displayName })
  }
  profiles.sort((a, b) => {
    if (a.dir === 'Default') return -1
    if (b.dir === 'Default') return 1
    return a.dir.localeCompare(b.dir)
  })
  return profiles
}

function initPlayChromeDir() {
  if (!fs.existsSync(CHROME_DIR)) return
  fs.mkdirSync(PLAYCHROME_DIR, { recursive: true })
  const dirs = fs.readdirSync(CHROME_DIR, { withFileTypes: true })
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    if (!d.name.match(/^(Default|Profile \d+)$/)) continue
    const realPath = path.join(CHROME_DIR, d.name)
    const linkPath = path.join(PLAYCHROME_DIR, d.name)
    if (!fs.existsSync(linkPath)) {
      try { fs.symlinkSync(realPath, linkPath) } catch {}
    }
  }
}

function getChromeCommand(profileDir) {
  const escapedProfile = profileDir.replace(/"/g, '\\"')
  const lines = [
    CHROME_PATH,
    `  --remote-debugging-port=${CDP_PORT}`,
    '  --remote-allow-origins="*"',
    `  --user-data-dir="${PLAYCHROME_DIR}"`,
    `  --profile-directory="${escapedProfile}"`,
    '  --no-first-run',
    '  about:blank'
  ]
  return lines.join(' \\\n')
}

function launchChrome(profileDir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CHROME_PATH)) {
      reject(new Error('Chrome not found at ' + CHROME_PATH))
      return
    }
    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${PLAYCHROME_DIR}`,
      `--profile-directory=${profileDir}`,
      '--no-first-run',
      'about:blank'
    ]
    const proc = spawn(CHROME_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    chromeProcess = proc
    proc.stderr.on('data', () => {})
    proc.on('error', (err) => { chromeProcess = null; reject(err) })
    proc.on('exit', () => { chromeProcess = null })

    let elapsed = 0
    const poll = setInterval(async () => {
      elapsed += 300
      if (await isPortOpen(CDP_PORT)) {
        clearInterval(poll)
        resolve()
      } else if (elapsed >= 10000) {
        clearInterval(poll)
        reject(new Error('Chrome launched but CDP port ' + CDP_PORT + ' not available within 10s'))
      }
    }, 300)
  })
}

async function connectToChrome() {
  if (browser) {
    try { await browser.close() } catch {}
    browser = null
    activePage = null
  }
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`
  const connectPromise = chromium.connectOverCDP(cdpUrl)
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Chrome CDP not available on port ' + CDP_PORT)), CDP_TIMEOUT))
  browser = await Promise.race([connectPromise, timeoutPromise])
  const contexts = browser.contexts()
  if (!contexts || contexts.length === 0) {
    const ctx = await browser.newContext()
    activePage = await ctx.newPage()
    return { pages: await getPagesInfo() }
  }
  const ctx = contexts[0]
  const pages = ctx.pages()
  if (!pages || pages.length === 0) {
    activePage = await ctx.newPage()
  } else {
    activePage = pages[0]
  }
  return { pages: await getPagesInfo() }
}

async function getPagesInfo() {
  if (!browser) return []
  const ctx = browser.contexts()[0]
  if (!ctx) return []
  const pages = ctx.pages()
  const info = []
  for (let i = 0; i < pages.length; i++) {
    try {
      info.push({ index: i, url: pages[i].url(), title: await pages[i].title() })
    } catch {
      info.push({ index: i, url: '', title: '(unavailable)' })
    }
  }
  return info
}

async function selectPage(index) {
  if (!browser) throw new Error('Not connected')
  const ctx = browser.contexts()[0]
  if (!ctx) throw new Error('No browser context')
  const pages = ctx.pages()
  if (index < 0 || index >= pages.length) throw new Error('Invalid page index')
  activePage = pages[index]
}

async function evaluate(code) {
  if (!activePage) throw new Error('No active page')
  const lines = []
  const consoleHandler = (msg) => lines.push('[' + msg.type() + '] ' + msg.text())
  activePage.on('console', consoleHandler)
  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error
  const serverLines = []
  console.log = (...args) => { serverLines.push('[log] ' + args.join(' ')); origLog(...args) }
  console.warn = (...args) => { serverLines.push('[warn] ' + args.join(' ')); origWarn(...args) }
  console.error = (...args) => { serverLines.push('[error] ' + args.join(' ')); origError(...args) }
  try {
    const fn = new Function('page', 'browser', `
      return (async () => {
        ${code}
      })()
    `)
    const raw = await fn(activePage, browser)
    await new Promise(r => setTimeout(r, CONSOLE_DELAY))
    let value = undefined
    if (raw !== undefined) {
      try { value = JSON.parse(JSON.stringify(raw, (k, v) => typeof v === 'function' ? undefined : v)) } catch { value = String(raw) }
    }
    const allLines = [...lines, ...serverLines]
    return { value, console: allLines }
  } finally {
    if (consoleHandler) activePage.off('console', consoleHandler)
    console.log = origLog
    console.warn = origWarn
    console.error = origError
  }
}

async function handleMessage(ws, msg) {
  try {
    switch (msg.type) {
      case 'CONNECT': {
        const result = await connectToChrome()
        ws.send(JSON.stringify({ type: 'CONNECTED', pages: result.pages }))
        break
      }
      case 'EVAL': {
        const result = await evaluate(msg.code)
        ws.send(JSON.stringify({ type: 'RESULT', id: msg.id, result }))
        break
      }
      case 'LIST_PAGES': {
        const pages = await getPagesInfo()
        ws.send(JSON.stringify({ type: 'PAGES', id: msg.id, pages }))
        break
      }
      case 'SELECT_PAGE': {
        await selectPage(msg.index)
        ws.send(JSON.stringify({ type: 'PAGE_SELECTED', id: msg.id, index: msg.index }))
        break
      }
      case 'GET_PROFILES': {
        const profiles = getProfiles()
        ws.send(JSON.stringify({ type: 'PROFILES', id: msg.id, profiles }))
        break
      }
      case 'PING': {
        ws.send(JSON.stringify({ type: 'PONG', id: msg.id }))
        break
      }
      default:
        ws.send(JSON.stringify({ type: 'ERROR', id: msg.id, error: { message: 'Unknown type: ' + msg.type } }))
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: 'ERROR', id: msg.id, error: { message: cleanError(err.message), stack: cleanError(err.stack) } }))
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, connected: !!browser }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('PlayChrome Server running')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  wsClients.add(ws)
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      handleMessage(ws, msg)
    } catch (err) {
      ws.send(JSON.stringify({ type: 'ERROR', error: { message: 'Invalid message: ' + err.message } }))
    }
  })
  ws.on('close', () => { wsClients.delete(ws) })
  ws.on('error', () => { wsClients.delete(ws) })
})

process.on('exit', () => {
  if (chromeProcess) { try { chromeProcess.kill() } catch {} }
  if (browser) { try { browser.close() } catch {} }
})

function printLiveConsole() {
  console.log('')
  console.log('##'.repeat(35))
  console.log('                     LIVE CONSOLE')
  console.log('##'.repeat(35))
}

async function main() {
  initPlayChromeDir()

  if (CLI.profilesOnly) {
    const profiles = getProfiles()
    if (profiles.length === 0) {
      console.log('No Chrome profiles found at ' + CHROME_DIR)
      process.exit(1)
    }
    console.log('Available profiles: \n')
    console.log('PROFILE \t ACCOUNT NAME')
    for (const p of profiles) {
      const line = `"${p.dir}"` + (p.name !== p.dir ? '\t(' + p.name + ')' : '')
      console.log('  ' + line)
    }
    console.log('')
    console.log('Launch command (replace {PROFILE} with the desired profile dir):')
    console.log('')
    console.log(getChromeCommand('{PROFILE}'))
    process.exit(0)
  }

  if (CLI.profile) {
    const profiles = getProfiles()
    const match = profiles.find(p => p.dir === CLI.profile)
    if (!match) {
      console.error('Profile "' + CLI.profile + '" not found. Use --profiles to list available profiles.')
      process.exit(1)
    }
    if (!fs.existsSync(CHROME_PATH)) {
      console.error('Chrome not found at ' + CHROME_PATH + '. Check --os value.')
      process.exit(1)
    }
    if (!(await isPortOpen(CDP_PORT))) {
      console.log('Launching Chrome with profile "' + CLI.profile + '"...')
      try {
        await launchChrome(CLI.profile)
      } catch (err) {
        console.error('Failed to launch Chrome:', err.message)
        process.exit(1)
      }
    }
    try {
      await connectToChrome()
    } catch (err) {
      console.error('Failed to connect to Chrome:', err.message)
      process.exit(1)
    }

    server.listen(PORT, () => {
      console.log('PlayChrome server on ws://127.0.0.1:' + PORT)
      console.log('Connected to Chrome profile: ' + match.name + ' (' + CLI.profile + ')')
      printLiveConsole()
    })
    return
  }

  const profiles = getProfiles()
  server.listen(PORT, () => {
    console.log('PlayChrome server on ws://127.0.0.1:' + PORT)
    console.log('Chrome CDP: port ' + CDP_PORT + ', profile dir: ' + PLAYCHROME_DIR)
    console.log('')
    if (profiles.length === 0) {
      console.log('WARNING: No Chrome profiles found at ' + CHROME_DIR)
    } else {
      console.log('Available profiles:')
      for (const p of profiles) {
        const line = p.dir + (p.name !== p.dir ? '  (' + p.name + ')' : '')
        console.log('  ' + line)
      }
      console.log('')
      console.log('Launch command (replace {PROFILE} with the desired profile dir):')
      console.log('')
      console.log(getChromeCommand('{PROFILE}'))
    }
    printLiveConsole()
  })
}

main().catch(err => { console.error(err); process.exit(1) })
