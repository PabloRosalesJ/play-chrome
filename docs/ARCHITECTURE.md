# PlayChrome Architecture

## Overview

PlayChrome is a REPL notebook in Chrome's sidepanel that executes real Playwright code against the browser's active page. The extension communicates via WebSocket with a local Node.js server that connects to Chrome through the Chrome DevTools Protocol (CDP).

## Components

### 1. Chrome Extension (MV3)

```
manifest.json          → Manifest V3, permissions: sidePanel, storage
service-worker.js       → Opens the sidepanel when clicking the icon
sidepanel.html          → Main UI (toolbar, cells, footer)
sidepanel.js            → Logic: WebSocket, cells, autocomplete, results
lib/notebook-core.js    → Cell CRUD, localStorage persistence
styles.css              → Dark theme, cell/output/toast styles
vendor/codemirror/      → CodeMirror 5.65.16 (core, JS mode, hint addon)
```

#### Extension flow

1. `service-worker.js` — on icon click, opens the sidepanel via `chrome.sidePanel.open()`
2. `sidepanel.html` loads scripts in order: CodeMirror → notebook-core → sidepanel.js
3. `sidepanel.js::init()` — restores notebook cells, binds toolbar events
4. User clicks **Connect** → WebSocket to `ws://127.0.0.1:3000`
5. On WebSocket open, sends `{ type: 'CONNECT' }` to the server
6. If Chrome CDP is unavailable, server responds with ERROR → extension shows `chrome-launcher` with instructions
7. If CONNECT succeeds, server responds `{ type: 'CONNECTED', pages: [...] }`
8. Extension populates `#page-selector` with available pages/tabs
9. User selects a page from the dropdown → sends `{ type: 'SELECT_PAGE', index }`
10. User writes code in a CodeMirror cell and clicks ▶ or `Ctrl+Enter`
11. Extension sends `{ type: 'EVAL', id, code }` to the server
12. Server executes the code with Playwright, returns `{ type: 'RESULT', id, result }`
13. Extension renders the result in the cell's output area

#### WebSocket messages

| Type (client → server) | Description |
|------------------------|-------------|
| `CONNECT` | Connect to Chrome via CDP |
| `EVAL { id, code }` | Execute Playwright code |
| `LIST_PAGES { id }` | List active pages/tabs |
| `SELECT_PAGE { id, index }` | Select active page |
| `GET_PROFILES { id }` | List Chrome profiles |
| `PING { id }` | Health check |

| Type (server → client) | Description |
|------------------------|-------------|
| `CONNECTED { pages }` | Successful connection, page list |
| `RESULT { id, result }` | Evaluation result |
| `ERROR { id, error }` | Error |
| `PROFILES { id, profiles }` | Detected profiles list |
| `PAGES { id, pages }` | Updated page list |
| `PAGE_SELECTED { id, index }` | Selected page confirmation |
| `PONG { id }` | Health check response |

### 2. Node.js Server

```
server/
  package.json       → Dependencies: playwright-core, ws
  index.js           → HTTP + WebSocket server, CDP connection, code evaluation
```

#### File: `server/index.js`

**Responsibilities:**
- Serve WebSocket at `ws://127.0.0.1:3000`
- Connect to Chrome via `playwright-core.chromium.connectOverCDP()`
- Execute arbitrary JavaScript code using `new Function()`
- Detect Chrome profiles in `~/Library/Application Support/Google/Chrome/`
- Initialize `~/.playchrome` with symlinks to real profiles

**Main functions:**

| Function | Description |
|----------|-------------|
| `getProfiles()` | Scans `CHROME_DIR` for subdirectories `Default` / `Profile N`, reads `Preferences` for the visible name |
| `initPlayChromeDir()` | Creates `PLAYCHROME_DIR` (`~/.playchrome`) and symlinks to real Chrome profiles |
| `getChromeCommand(profile)` | Generates the shell command to launch Chrome with a specific profile and CDP enabled |
| `connectToChrome()` | Closes previous connection (if any), connects via `chromium.connectOverCDP()` to `http://127.0.0.1:9222` |
| `getPagesInfo()` | Gets the list of open pages from the first browser context |
| `selectPage(index)` | Switches the active page |
| `evaluate(code)` | Executes code on the server with access to `page` and `browser`, captures page and server console.log |
| `handleMessage(ws, msg)` | WebSocket message router |

**Code evaluation:**
```javascript
const fn = new Function('page', 'browser', `
  return (async () => {
    ${code}
  })()
`)
const raw = await fn(activePage, browser)
```

The code runs in Node.js with the variables `page` (Playwright Page) and `browser` (Playwright Browser) injected. To operate in the web page context, use `page.evaluate()`.

**Global variables across all cells (Jupyter-like behavior):**
- `page` — the active Chrome tab. Created by the server via `connectOverCDP` on CONNECT.
- `browser` — the Playwright BrowserContext.
- `console.log()`, `console.warn()`, `console.error()` — captured and displayed in the output.
- `sleep(ms)` — utility for pauses in async code (`await sleep(500)`).
- Any variable declared with `let`/`const`/`var`/`function`/`class` in a cell persists as a global for subsequent cells (the server removes `let/const/var` from the start of lines and converts them to global assignments via `new Function()` in sloppy mode).

**Console capture:**
- Page-side: `page.on('console')` captures `console.log` messages inside `page.evaluate()`
- Server-side: temporary override of `console.log`/`warn`/`error` to capture user code logs
- Both are combined and returned with the result

### 3. CDP Connection

Chrome must be started with:
- `--remote-debugging-port=9222`
- `--remote-allow-origins="*"` (required Chrome 112+)
- `--user-data-dir=<non-default-path>` (required Chrome 149+)

Playwright connects via `chromium.connectOverCDP('http://127.0.0.1:9222')` which internally:
1. GETs `http://127.0.0.1:9222/json/version` to get the WebSocket URL
2. Connects via WebSocket to the CDP endpoint
3. Exposes `browser.contexts()` and `context.pages()` with existing pages

### 4. Profile management

Chrome 149+ **does not allow** `--remote-debugging-port` with the default `--user-data-dir` (`~/Library/Application Support/Google/Chrome`). Solution:

1. The server creates `~/.playchrome/` on startup
2. Creates symlinks of the real profiles (Default, Profile 1, etc.) inside `~/.playchrome/`
3. The user launches Chrome with `--user-data-dir=$HOME/.playchrome --profile-directory="Profile 1"`
4. Chrome sees a non-default `--user-data-dir` and allows CDP
5. Profile data is read from the symlink → it's the user's real profile

## Data flow

```
User writes code in CodeMirror cell
  → click ▶ or Ctrl+Enter
    → sidepanel.js::executeCell(cellId)
      → validate connected + ws open
      → sidepanel.js::evaluateOnServer(code)
        → sends { type: 'EVAL', id, code } via WebSocket
          → server/index.js::handleMessage()
            → server/index.js::evaluate(code)
              → new Function('page', 'browser', 'return (async () => { ... })()')
                → Playwright executes on real Chrome
              → captures console.log (page + server)
              → returns { value, console }
            → sends { type: 'RESULT', id, result } via WebSocket
          → sidepanel.js::handleServerMessage()
            → resolvePending(msg)
              → sidepanel.js::formatResult()
                → sidepanel.js::renderOutput()
                  → Renders in .cell-output
```

## Dependencies

### Server (`server/package.json`)
- `playwright-core` ^1.52.0 — no browser binaries (uses `connectOverCDP`)
- `ws` ^8.18.0 — WebSocket server

### Extension (vendors)
- CodeMirror 5.65.16 — code editor for cells
- No external npm dependencies or bundlers

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | WebSocket server port |
| `CDP_PORT` | `9222` | Chrome CDP port |

## Server constants

```javascript
CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
CHROME_DIR = '~/Library/Application Support/Google/Chrome'
PLAYCHROME_DIR = '~/.playchrome'
CDP_TIMEOUT = 8000       // ms
CONSOLE_DELAY = 80       // ms — wait time to capture console.log
```
