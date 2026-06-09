const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const { chromium } = require('playwright-core')

const PORT = parseInt(process.env.PORT || '3000', 10)
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10)
const CONSOLE_DELAY = 80
const CDP_TIMEOUT = 8000

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CHROME_DIR = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome')
const PLAYCHROME_DIR = path.join(process.env.HOME || '', '.playchrome')

let browser = null
let activePage = null
const wsClients = new Set()

function cleanError(msg) {
  return String(msg).replace(/\u001b\[[0-9;]*m/g, '').trim()
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

async function connectToChrome() {
  if (browser) {
    try { await browser.close() } catch {}
    browser = null
    activePage = null
  }
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`
  const connectPromise = chromium.connectOverCDP(cdpUrl)
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Chrome CDP not available on port ${CDP_PORT}`)), CDP_TIMEOUT))
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
  const consoleHandler = (msg) => lines.push(`[${msg.type()}] ${msg.text()}`)
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
  if (browser) { try { browser.close() } catch {} }
})

initPlayChromeDir()
const profiles = getProfiles()

server.listen(PORT, () => {
  console.log(`PlayChrome server on ws://127.0.0.1:${PORT}`)
  console.log(`Chrome CDP: port ${CDP_PORT}, profile dir: ${PLAYCHROME_DIR}`)
  console.log('')
  if (profiles.length === 0) {
    console.log('WARNING: No Chrome profiles found at ' + CHROME_DIR)
  } else {
    console.log('Available profiles:')
    for (const p of profiles) {
      console.log(`  ${p.dir.padEnd(12)} → ${p.name}`)
    }
    console.log('')
    console.log('Launch Chrome with one of these commands:')
    for (const p of profiles) {
      console.log('')
      console.log(getChromeCommand(p.dir))
    }
  }
})
