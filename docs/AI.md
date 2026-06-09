# PlayChrome — Documentation for AI

This document describes the PlayChrome project so any AI agent can understand its structure, purpose, and how to modify it without breaking it.

## What is PlayChrome?

PlayChrome is an **interactive notebook** inside Chrome's sidepanel that lets you execute **Playwright** code directly against the page the user has open. It's like a Jupyter notebook, but for manipulating the browser's DOM with the full Playwright API.

### Use case

A user is on `https://mydomain.com/admin/users` and wants to:
- Extract data from a table
- Click buttons
- Fill forms
- Take screenshots

Instead of opening DevTools and writing JavaScript, they use PlayChrome which gives them access to the full Playwright API.

## Project structure

```
playchrome/
├── manifest.json           → Chrome Extension MV3 manifest
├── service-worker.js       → Service worker (opens sidepanel)
├── sidepanel.html          → Sidepanel UI
├── sidepanel.js            → Sidepanel logic (~562 lines)
├── styles.css              → Dark theme
├── lib/
│   └── notebook-core.js    → Cell persistence (localStorage)
├── server/
│   ├── package.json        → Server dependencies
│   ├── index.js            → WebSocket server + Playwright (~240 lines)
│   └── node_modules/       → playwright-core, ws
├── vendor/
│   └── codemirror/         → CodeMirror 5.65.16 (editor)
└── docs/
    ├── ARCHITECTURE.md     → Detailed architecture
    └── AI.md               → This file
```

## Code conventions

### General
- No comments in code (unless strictly necessary)
- camelCase variables
- Async functions with `async/await`
- Errors cleaned with `cleanError()` (strip ANSI codes)
- WebSocket messages are JSON with a `type` field

### Server (`server/index.js`)
- Mutable global state: `browser`, `activePage`, `chromeProcess`, `wsClients`
- HTTP WebSocket server on port `PORT` (default 3000)
- CDP connection to `http://127.0.0.1:CDP_PORT` (default 9222)
- Code evaluation via `new Function('page', 'browser', 'return (async () => { ... })()')`
- `page` and `browser` are global variables available in every cell. `page` = active tab, `browser` = BrowserContext.
- `prepareUserCode()` removes `let/const/var/function/class` from the start of lines so variables persist as globals between cells (Jupyter-like).
- Does NOT use `eval()` — uses `new Function()` which is less restrictive
- Page console.log captured via `page.on('console')`
- Server console.log captured via temporary override of `console.log`

### Extension (`sidepanel.js`)
- WebSocket client with manual reconnect
- Notebook cells: CodeMirror 5 with custom hinting
- Notebook persisted in localStorage via `lib/notebook-core.js`
- Results rendered as HTML in `.cell-output`
- `evalPending` Map to correlate requests/responses

### Extension Service Worker (`service-worker.js`)
- Minimal: only opens the sidepanel when clicking the icon

## Critical rules

### DO NOT
1. **DO NOT kill Chrome** — the server must never kill Chrome processes
2. **DO NOT auto-launch Chrome** — the user launches Chrome manually with the provided command
3. **DO NOT use `eval()` in the extension** — MV3 does not allow `unsafe-eval`. `new Function()` only on the server
4. **DO NOT change the default `--user-data-dir`** — Chrome 149 requires a non-default one for CDP; use `~/.playchrome` with symlinks
5. **DO NOT assume Chrome is at a specific path** — validate with `fs.existsSync()`

### DO
1. Clean errors with `cleanError()` before sending to the client
2. Timeout on CDP connections (8s) to not hang the server
3. Capture console.log from both sides (page + server)
4. Restore original console.log in the `finally` of evaluate()
5. Close previous browser before reconnecting in `connectToChrome()`
6. Create `~/.playchrome` with symlinks on startup

## How to modify the project

### Add a new WebSocket message type

**Server** (`server/index.js`):
1. Add case in `handleMessage()` switch
2. Implement the logic
3. Send response with `ws.send(JSON.stringify({ type: 'NEW_TYPE', ... }))`

**Extension** (`sidepanel.js`):
1. Send message with `sendToServer({ type: 'NEW_TYPE', id, ... })`
2. Add case in `handleServerMessage()` switch
3. Process response

### Add an autocomplete hint

In `sidepanel.js::makeHint()`, array `hints`:
```javascript
const hints = [
  // ... existing
  'page.newMethod',  // <-- add here
]
```

### Change the CDP port

```bash
CDP_PORT=9223 node server/index.js
```

### Support another browser

In `server/index.js`, change `chromium` to `firefox` or `webkit` from `playwright-core`:
```javascript
const { chromium, firefox, webkit } = require('playwright-core')
// Use firefox.connectOverCDP(cdpUrl)
```

### Support Linux

Change `CHROME_PATH`:
```javascript
const CHROME_PATH = '/usr/bin/google-chrome'  // Linux
const CHROME_DIR = path.join(process.env.HOME || '', '.config/google-chrome')
```

## Testing

The project doesn't have a formal test suite. To test:

```bash
# Test server
node server/index.js

# In another terminal, test WebSocket connection:
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:3000");
ws.on("open", () => ws.send(JSON.stringify({type:"CONNECT", id:"test"})));
ws.on("message", (d) => { console.log(JSON.parse(d)); ws.close(); });
'

# Test EVAL (after connecting Chrome with CDP):
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:3000");
ws.on("open", () => ws.send(JSON.stringify({type:"CONNECT", id:"c"})));
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type==="CONNECTED")
    ws.send(JSON.stringify({type:"EVAL",id:"e",code:"return await page.title();"}));
  if (m.type==="RESULT") { console.log(m.result); ws.close(); }
});
'
```

## Chrome profiles

The server detects profiles in `~/Library/Application Support/Google/Chrome/` by filtering for names `Default` or `Profile N`. It reads `Preferences` → `profile.name` for the visible name.

**IMPORTANT**: Each profile has a different `--profile-directory`. Do not confuse the visible name (e.g. "Personal") with the directory name (e.g. "Profile 2").

## Chrome 149+ and CDP

Chrome 149 introduced a change: `--remote-debugging-port` **does not work** with the default `--user-data-dir`. The server solves this:
1. Creates `~/.playchrome/` on startup
2. Symlinks the real profiles inside it
3. The user launches Chrome pointing to `~/.playchrome`

If Chrome reverts this in the future, you can remove `initPlayChromeDir()` and use `CHROME_DIR` directly.

## Glossary

| Term | Meaning |
|------|---------|
| CDP | Chrome DevTools Protocol — protocol for programmatically controlling Chrome |
| `connectOverCDP` | Playwright method that connects to an already running Chrome via CDP |
| Browser Context | Session isolation in Playwright (equivalent to an incognito window) |
| Sidepanel | Chrome Extension MV3 side panel |
| MV3 | Manifest V3 — current version of the Chrome extensions model |
