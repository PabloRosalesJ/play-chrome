let ws = null
let connected = false
const codeMirrorInstances = new Map()
const evalPending = new Map()
let evalRequestId = 0
let autocompleteTimer = null
let lastServerUrl = 'ws://127.0.0.1:3000'
let userGlobals = []

document.addEventListener('DOMContentLoaded', init)

function init() {
  bindToolbar()
  loadNotebook()
  restoreCells()
  const urlInput = document.getElementById('server-url')
  const saved = localStorage.getItem('playchrome_server_url')
  if (saved) { urlInput.value = saved; lastServerUrl = saved }
}

function bindToolbar() {
  document.getElementById('btn-connect').addEventListener('click', toggleConnect)
  document.getElementById('btn-new-cell').addEventListener('click', addNewCell)
  document.getElementById('btn-run-all').addEventListener('click', runAllCells)
  document.getElementById('btn-clear').addEventListener('click', clearAll)
  document.getElementById('page-selector').addEventListener('change', onPageSelect)
  document.getElementById('server-url').addEventListener('change', (e) => {
    lastServerUrl = e.target.value.trim()
    localStorage.setItem('playchrome_server_url', lastServerUrl)
  })
}

function renumberCells() {
  const cells = getAllCells()
  cells.forEach((cell, i) => {
    const el = document.getElementById(cell.id)
    const label = el?.querySelector('.cell-label')
    if (label) label.textContent = 'cell ' + (i + 1)
  })
}

function setConnected(state) {
  connected = state
  const badge = document.getElementById('status-badge')
  badge.textContent = state ? 'connected' : 'disconnected'
  badge.className = state ? 'status-connected' : 'status-disconnected'
  const btn = document.getElementById('btn-connect')
  btn.textContent = state ? '🔌 Disconnect' : '🔌 Connect'
  document.getElementById('page-selector').disabled = !state
}

function showToast(msg, isError) {
  const existing = document.querySelector('.toast')
  if (existing) existing.remove()
  const toast = document.createElement('div')
  toast.className = 'toast' + (isError ? ' toast-error' : '')
  toast.textContent = msg
  document.body.appendChild(toast)
  const duration = isError ? Math.max(5000, msg.length * 30) : 2500
  setTimeout(() => toast.remove(), duration)
}

// ---- Chrome Launcher ----

function showLauncher(cdpPort) {
  document.getElementById('chrome-launcher').style.display = 'block'
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendToServer({ type: 'GET_PROFILES', id: 'profiles' })
  }
  showToast('Chrome CDP no disponible en puerto ' + cdpPort + ' — mira las instrucciones', true)
}

function hideLauncher() {
  document.getElementById('chrome-launcher').style.display = 'none'
}

// ---- WebSocket ----

async function toggleConnect() {
  if (ws) {
    ws.close()
    ws = null
    setConnected(false)
    return
  }
  const url = document.getElementById('server-url').value.trim() || lastServerUrl
  lastServerUrl = url
  localStorage.setItem('playchrome_server_url', url)
  await connectToServer(url)
}

function connectToServer(url) {
  return new Promise((resolve) => {
    try {
      ws = new WebSocket(url)
    } catch (e) {
      showToast('Connection failed: ' + e.message)
      setConnected(false)
      resolve()
      return
    }
    const btn = document.getElementById('btn-connect')
    btn.textContent = '⏳ ...'
    btn.disabled = true

    ws.onopen = async () => {
      showToast('Connected to server, connecting to Chrome...')
      ws.send(JSON.stringify({ type: 'CONNECT', id: 'connect-0' }))
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        handleServerMessage(msg)
      } catch (e) {
        console.error('Invalid message:', event.data)
      }
    }

    ws.onclose = () => {
      if (connected) showToast('Disconnected from server')
      setConnected(false)
      hideLauncher()
      btn.disabled = false
      ws = null
      for (const [id, pending] of evalPending) {
        pending.reject(new Error('Server disconnected'))
        evalPending.delete(id)
      }
      document.getElementById('page-selector').innerHTML = '<option value="">— no page —</option>'
      resolve()
    }

    ws.onerror = () => {
      showToast('WebSocket error — is the server running?')
      setConnected(false)
      btn.disabled = false
      resolve()
    }
  })
}

function sendToServer(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Not connected to server')
  }
  ws.send(JSON.stringify(msg))
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'CONNECTED':
      hideLauncher()
      setConnected(true)
      document.getElementById('btn-connect').disabled = false
      populatePageSelector(msg.pages || [])
      showToast('Connected · ' + (msg.pages?.length || 0) + ' pages available')
      break
    case 'RESULT':
      if (msg.result?.globals) {
        const set = new Set(userGlobals)
        for (const g of msg.result.globals) set.add(g)
        userGlobals = [...set]
      }
      resolvePending(msg)
      break
    case 'ERROR':
      if (msg.id === 'connect-0') {
        setConnected(false)
        document.getElementById('btn-connect').disabled = false
        const errMsg = msg.error?.message || 'Unknown error'
        if (errMsg.toLowerCase().includes('not available')) {
          showLauncher(9222)
        } else {
          showToast('Chrome connection failed: ' + errMsg, true)
        }
      }
      rejectPending(msg)
      break
    case 'PROFILES':
      showProfiles(msg.profiles || [])
      break
    case 'PAGES':
      populatePageSelector(msg.pages || [])
      break
    case 'PAGE_SELECTED':
      break
    case 'PONG':
      break
    default:
      console.warn('Unknown message type:', msg.type)
  }
}

function showProfiles(profiles) {
  const inst = document.getElementById('launch-instructions')
  if (!profiles || profiles.length === 0) {
    inst.textContent = 'No se encontraron perfiles de Chrome.'
    return
  }
  const lines = profiles.map(p => {
    const cmd = [
      '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome',
      '  --remote-debugging-port=9222',
      '  --remote-allow-origins="*"',
      '  --user-data-dir="$HOME/.playchrome"',
      '  --profile-directory="' + p.dir + '"',
      '  --no-first-run',
      '  about:blank'
    ].join(' \\\n')
    return '# ' + p.dir + ' → ' + p.name + '\n' + cmd
  })
  inst.textContent = lines.join('\n\n')
  inst.style.display = 'block'
}



function resolvePending(msg) {
  const pending = evalPending.get(msg.id)
  if (!pending) return
  evalPending.delete(msg.id)
  pending.resolve(msg.result)
}

function rejectPending(msg) {
  const pending = evalPending.get(msg.id)
  if (!pending) return
  evalPending.delete(msg.id)
  pending.reject(new Error(msg.error?.message || 'Unknown error'))
}

function evaluateOnServer(code) {
  return new Promise((resolve, reject) => {
    const id = 'eval-' + (++evalRequestId)
    evalPending.set(id, { resolve, reject })
    try {
      sendToServer({ type: 'EVAL', id, code })
    } catch (e) {
      evalPending.delete(id)
      reject(e)
      return
    }
    setTimeout(() => {
      if (evalPending.has(id)) {
        evalPending.delete(id)
        reject(new Error('Evaluation timeout (30s)'))
      }
    }, 30000)
  })
}

// ---- Page Selector ----

function populatePageSelector(pages) {
  const sel = document.getElementById('page-selector')
  sel.innerHTML = ''
  if (!pages || pages.length === 0) {
    sel.innerHTML = '<option value="">— no pages —</option>'
    return
  }
  for (const p of pages) {
    const opt = document.createElement('option')
    opt.value = p.index
    const label = p.title ? p.title.substring(0, 60) : '(untitled)'
    const url = p.url ? p.url.substring(0, 50) : ''
    opt.textContent = `[${p.index}] ${label}${url ? ' — ' + url : ''}`
    opt.title = p.url || ''
    sel.appendChild(opt)
  }
}

function onPageSelect() {
  const sel = document.getElementById('page-selector')
  const idx = parseInt(sel.value, 10)
  if (!isNaN(idx) && ws && ws.readyState === WebSocket.OPEN) {
    sendToServer({ type: 'SELECT_PAGE', id: 'sel-' + Date.now(), index: idx })
  }
}

// ---- Refresh pages (polling) ----

function refreshPages() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { sendToServer({ type: 'LIST_PAGES', id: 'list-' + Date.now() }) } catch {}
  }
}

// ---- Cells ----

function restoreCells() {
  const container = document.getElementById('cells-container')
  container.innerHTML = ''
  codeMirrorInstances.clear()
  let cells = getAllCells()
  if (cells.length === 0) {
    addCell('')
    cells = getAllCells()
  }
  for (const cell of cells) {
    createCellUI(cell)
  }
  renumberCells()
}

function addNewCell() {
  const cell = addCell('')
  createCellUI(cell)
  requestAnimationFrame(() => {
    const cm = codeMirrorInstances.get(cell.id)
    if (cm) {
      cm.focus()
      const container = document.getElementById('cells-container')
      container.scrollTop = container.scrollHeight
    }
  })
}

function createCellUI(cell) {
  const container = document.getElementById('cells-container')
  const div = document.createElement('div')
  div.id = cell.id
  div.className = 'cell cell-status-idle'

  const header = document.createElement('div')
  header.className = 'cell-header'

  const label = document.createElement('span')
  label.className = 'cell-label'
  const cells = getAllCells()
  const idx = cells.indexOf(cell) + 1
  label.textContent = 'cell ' + idx

  const actions = document.createElement('div')
  actions.className = 'cell-actions'

  const runBtn = document.createElement('button')
  runBtn.textContent = '▶'
  runBtn.title = 'Run cell (Ctrl+Enter)'
  runBtn.addEventListener('click', () => executeCell(cell.id))

  const addBtn = document.createElement('button')
  addBtn.textContent = '+'
  addBtn.title = 'Insert cell below'
  addBtn.addEventListener('click', () => {
    const newCell = addCell('')
    createCellUI(newCell)
  })

  const delBtn = document.createElement('button')
  delBtn.textContent = '✕'
  delBtn.title = 'Delete cell'
  delBtn.addEventListener('click', () => {
    removeCell(cell.id)
    const el = document.getElementById(cell.id)
    if (el) el.remove()
    const cm = codeMirrorInstances.get(cell.id)
    if (cm) {
      cm.toTextArea()
      codeMirrorInstances.delete(cell.id)
    }
    renumberCells()
  })

  actions.appendChild(runBtn)
  actions.appendChild(addBtn)
  actions.appendChild(delBtn)
  header.appendChild(label)
  header.appendChild(actions)
  div.appendChild(header)

  const editorDiv = document.createElement('div')
  editorDiv.className = 'cell-editor'
  div.appendChild(editorDiv)

  const outputDiv = document.createElement('div')
  outputDiv.className = 'cell-output'
  div.appendChild(outputDiv)

  container.appendChild(div)

  const cm = CodeMirror(editorDiv, {
    value: cell.code || '',
    mode: 'javascript',
    theme: 'default',
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    lineWrapping: true,
    extraKeys: {
      'Ctrl-Enter': () => executeCell(cell.id),
      'Shift-Enter': () => {
        executeCell(cell.id)
        addNewCell()
      },
      'Ctrl-Shift-Enter': () => addNewCell()
    }
  })

  function resizeEditor() {
    const lines = cm.getDoc().lineCount()
    const h = Math.max(40, Math.min(400, lines * 22 + 10))
    cm.setSize(null, h)
  }

  cm.on('change', () => {
    cell.code = cm.getValue()
    updateCellCode(cell.id, cm.getValue())
    resizeEditor()
  })

  cm.on('inputRead', (cm, change) => {
    if (autocompleteTimer) clearTimeout(autocompleteTimer)
    if (change.text.length > 0 && (/\w/.test(change.text[0]) || change.text[0] === '.')) {
      autocompleteTimer = setTimeout(() => {
        cm.showHint({ hint: makeHint(), completeSingle: false })
      }, 300)
    }
  })

  resizeEditor()
  codeMirrorInstances.set(cell.id, cm)

  if (cell.output) {
    renderOutput(outputDiv, cell.output)
  }
}

function makeHint() {
  const hints = [
    ...userGlobals,
    'page', 'browser',
    'page.goto', 'page.locator', 'page.getByRole', 'page.getByText', 'page.getByLabel',
    'page.getByPlaceholder', 'page.getByAltText', 'page.getByTitle', 'page.getByTestId',
    'page.click', 'page.fill', 'page.type', 'page.selectOption',
    'page.check', 'page.uncheck', 'page.hover', 'page.focus', 'page.press',
    'page.screenshot', 'page.pdf', 'page.content', 'page.title', 'page.url',
    'page.evaluate', 'page.evaluateHandle',
    'page.waitForSelector', 'page.waitForNavigation', 'page.waitForLoadState',
    'page.waitForTimeout', 'page.waitForURL',
    'page.reload', 'page.goBack', 'page.goForward',
    'page.setContent', 'page.setViewportSize',
    'page.cookies', 'page.setExtraHTTPHeaders', 'page.setOffline',
    'page.addScriptTag', 'page.addStyleTag',
    'page.on', 'page.once',
    'page.frame', 'page.frames', 'page.mainFrame',
    'page.frameLocator',
    'page.route', 'page.unroute',
    'page.close', 'page.isClosed',
    'page.keyboard', 'page.mouse', 'page.touchscreen',
    'page.viewportSize',
    'page.locator().click', 'page.locator().fill', 'page.locator().type',
    'page.locator().textContent', 'page.locator().innerText', 'page.locator().innerHTML',
    'page.locator().count', 'page.locator().all', 'page.locator().first', 'page.locator().last',
    'page.locator().nth', 'page.locator().filter', 'page.locator().waitFor',
    'page.locator().screenshot', 'page.locator().hover', 'page.locator().focus',
    'page.locator().press', 'page.locator().isVisible', 'page.locator().isHidden',
    'page.locator().isEnabled', 'page.locator().isChecked',
    'page.locator().getAttribute', 'page.locator().evaluate',
    'browser.newPage', 'browser.contexts', 'browser.close',
    'console.log', 'console.warn', 'console.error',
    'sleep', 'await'
  ]

  return function(editor, options) {
    const cursor = editor.getCursor()
    const token = editor.getTokenAt(cursor)
    const start = token.start
    const end = cursor.ch
    const word = token.string.slice(0, end - start)

    const result = CodeMirror.hint.javascript
      ? CodeMirror.hint.javascript(editor, options)
      : null

    const prevChar = editor.getRange(
      { line: cursor.line, ch: Math.max(0, start - 1) },
      { line: cursor.line, ch: start }
    )

    if (prevChar !== '.' && word.length > 0) {
      const filtered = hints
        .filter(h => h.startsWith(word))
        .map(h => ({
          text: h,
          displayText: h,
          className: 'cm-hint-api'
        }))
      if (filtered.length > 0) {
        if (result) {
          result.list = [...filtered, ...result.list]
          return result
        }
        return {
          list: filtered,
          from: { line: cursor.line, ch: start },
          to: { line: cursor.line, ch: end }
        }
      }
    }
    return result
  }
}

async function executeCell(cellId) {
  const cm = codeMirrorInstances.get(cellId)
  if (!cm) return

  const code = cm.getValue().trim()
  if (!code) return

  const cell = getAllCells().find(c => c.id === cellId)
  if (!cell) return

  setCellStatus(cellId, 'running')
  const div = document.getElementById(cellId)
  if (div) div.className = 'cell cell-status-running'
  const outputDiv = div?.querySelector('.cell-output')
  if (outputDiv) outputDiv.innerHTML = '<span class="output-info">running...</span>'

  try {
    if (!connected || !ws) {
      throw new Error('Not connected to PlayChrome server. Click Connect first.')
    }
    const raw = await evaluateOnServer(code)
    const output = formatResult(raw._value !== undefined ? raw._value : raw.value, raw._console || raw.console || [])
    cell.output = output
    updateCellOutput(cellId, output)
    if (outputDiv) renderOutput(outputDiv, output)
    if (div) div.className = 'cell cell-status-success'
    refreshPages()
  } catch (e) {
    const output = { type: 'error', message: e.message, stack: e.stack }
    cell.output = output
    updateCellOutput(cellId, output)
    if (outputDiv) renderOutput(outputDiv, output)
    if (div) div.className = 'cell cell-status-error'
  }
}

function formatResult(value, consoleLines) {
  let output
  if (value === undefined || value === null) {
    output = { type: 'undefined', text: String(value) }
  } else if (typeof value === 'string') {
    if (value.startsWith('data:image/')) output = { type: 'image', data: value }
    else if (value.startsWith('data:application/pdf')) output = { type: 'pdf', data: value }
    else output = { type: 'string', text: value }
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    output = { type: 'value', text: String(value), value }
  } else if (Array.isArray(value) || typeof value === 'object') {
    output = { type: 'json', data: value }
  } else {
    output = { type: 'text', text: String(value) }
  }
  if (consoleLines?.length) output.console = consoleLines
  return output
}

function renderOutput(container, output) {
  if (!output) { container.innerHTML = ''; return }
  let parts = ''
  if (output.console?.length) {
    for (const line of output.console) {
      parts += '<div class="output-console">' + escapeHtml(line) + '</div>'
    }
    if (output.type === 'undefined') { container.innerHTML = parts; return }
  }
  switch (output.type) {
    case 'string':
      parts += '<span class="output-string">' + escapeHtml(output.text) + '</span>'
      break
    case 'value':
      parts += '<span class="output-number">' + escapeHtml(output.text) + '</span>'
      break
    case 'json':
      parts += '<span class="output-json">' + escapeHtml(JSON.stringify(output.data, null, 2)) + '</span>'
      break
    case 'image':
      parts += '<img class="output-image" src="' + output.data + '" />'
      break
    case 'pdf':
      parts += '<a class="output-link" href="' + output.data + '" target="_blank">Open PDF</a>'
      break
    case 'error':
      parts += '<div class="output-error">' + escapeHtml(output.message) + '</div>'
      if (output.stack) {
        parts += '<div class="output-error" style="font-size:11px;opacity:0.7;margin-top:4px">' + escapeHtml(output.stack) + '</div>'
      }
      break
    case 'undefined':
      parts += '<span class="output-undefined">' + escapeHtml(output.text) + '</span>'
      break
    default:
      parts += '<span class="output-text">' + escapeHtml(String(output.text || output.content || '')) + '</span>'
  }
  container.innerHTML = parts
}

function runAllCells() {
  const cells = getAllCells()
  for (const cell of cells) executeCell(cell.id)
}

function clearAll() {
  const allCells = getAllCells()
  for (const cell of allCells) {
    const cm = codeMirrorInstances.get(cell.id)
    if (cm) {
      cm.toTextArea()
      codeMirrorInstances.delete(cell.id)
    }
  }
  clearAllCells()
  document.getElementById('cells-container').innerHTML = ''
  addNewCell()
}

function escapeHtml(str) {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
    e.preventDefault()
    addNewCell()
  }
})
