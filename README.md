# PlayChrome

Chrome extension sidepanel notebook to manipulate the DOM of any page using **real Playwright** via WebSocket.

## Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Operating System** | macOS (Apple Silicon or Intel) | Linux compatible with path changes (see docs) |
| **Google Chrome** | 149+ | Canary, Dev, Beta or Stable |
| **Node.js** | 20+ | Includes npm |

> **Playwright**: You don't need to install browsers (`npx playwright install`). The server uses `playwright-core` which connects to your already installed Chrome via CDP — no additional browsers are downloaded.

## Installation

### 1. Install Node.js (if you don't have it)

```bash
# Option A — Homebrew (recommended)
brew install node

# Option B — nvm (if you need multiple versions)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22

# Option C — Download from https://nodejs.org (v20 LTS or higher)
```

Verify:
```bash
node --version   # → v20.x.x or higher
npm --version    # → 10.x.x or higher
```

### 2. Clone and install dependencies

```bash
cd playchrome
npm --prefix server install
```

This installs `playwright-core` and `ws` inside `server/node_modules/`. No `sudo` needed.

### 3. Load the extension in Chrome

1. Open `chrome://extensions/` in Chrome
2. Enable **"Developer mode"** (toggle in top right corner)
3. Click **"Load unpacked"**
4. Select the `playchrome` folder (project root)
5. You'll see the **PlayChrome** card in the extensions list
6. Pin it to the toolbar (click the puzzle icon → pin PlayChrome)

> ⚠️ The extension uses the `sidePanel` API (Chrome 114+). If the icon doesn't open the sidepanel, verify you're on Chrome 114+ and restart Chrome.

## How to use

### Quick usage (recommended)

```bash
# 1. List available profiles
node server/index.js --os mac --profiles

# 2. Start server + Chrome with your profile (all in one)
node server/index.js --os mac --profile "Profile 1"
```

The server launches Chrome automatically, connects via CDP, and shows only the live console.

### Manual usage (server + Chrome separately)

```bash
# 1. Start the server
node server/index.js

# 2. Copy the command the server prints for your profile
#    and run it in another terminal:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-allow-origins="*" \
  --user-data-dir="$HOME/.playchrome" \
  --profile-directory="Profile 1" \
  --no-first-run \
  about:blank

> Chrome 149+ **requires** a non-default `--user-data-dir` to enable CDP.
> The server creates `~/.playchrome` with symlinks to your real profiles.
```

### 3. Connect the extension

- Navigate to the page you want to manipulate
- Click the PlayChrome icon in the extensions toolbar
- Click **Connect**
- Write Playwright code in the notebook cells

### Variables available in cells

| Variable | Description |
|----------|-------------|
| `page` | Active Playwright page (`Page` object) |
| `browser` | Browser instance (`Browser` object) |

### Examples

```javascript
// Navigate and get title
await page.goto('https://example.com');
return await page.title();

// Extract text
return await page.evaluate(() => document.body.innerText);

// Click an element
await page.locator('button.submit').click();

// Take screenshot (returns base64)
return await page.screenshot({ encoding: 'base64' });
```

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Execute cell |
| `Shift+Enter` | Execute and create new cell |
| `Ctrl+Shift+Enter` | Create new cell |

## Server flags

| Flag | Example | Description |
|------|---------|-------------|
| `--os <system>` | `--os mac` | Operating system: `mac`, `linux`, `win` |
| `--profile <dir>` | `--profile "Profile 1"` | Starts server + Chrome with that profile (silent mode) |
| `--profiles` | `--profiles` | Lists profiles and commands, does not start the server |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | WebSocket server port |
| `CDP_PORT` | `9222` | Chrome CDP port |

## Architecture

```
┌──────────────────────┐     WebSocket      ┌──────────────────────┐
│  Chrome Extension    │ ◄─────────────────► │  Node.js Server     │
│  (sidepanel.html)    │    ws://127.0.0.1   │  (server/index.js)  │
│                      │          :3000      │                      │
│  CodeMirror cells ───┤ EVAL code ────────► │  new Function()     │
│  Result display ◄────┤ RESULT ◄─────────── │  evaluate(code)     │
│                      │                     │                      │
│  Connect/Disconnect  │ CONNECT msg ───────►│  connectOverCDP()   │
│  Page selector       │ LIST_PAGES ◄─────── │  getPagesInfo()     │
└──────────────────────┘                     └─────────┬────────────┘
                                                       │ CDP
                                                       ▼
                                             ┌──────────────────┐
                                             │  Chrome Browser  │
                                             │  (port 9222)     │
                                             │                  │
                                             │  Real Playwright │
                                             │  page.goto()     │
                                             │  page.locator()  │
                                             │  page.evaluate() │
                                             └──────────────────┘
```

For detailed documentation, see [`docs/`](./docs/).

## Limitations

- **System**: developed and tested on macOS. Linux requires changing `CHROME_PATH` and `CHROME_DIR` in `server/index.js` (see [docs/AI.md](./docs/AI.md#soportar-linux))
- **Windows**: not currently supported (hardcoded macOS paths)
- **Chrome 149+**: requires `--remote-debugging-port` and non-default `--user-data-dir`
- **Single server**: one server instance handles all WebSocket connections
- **Code runs in Node.js**: cells execute on the server (not on the page). Use `page.evaluate()` for page-context code
- **No `unsafe-eval`**: uses `new Function()` on the server (not in the extension), compatible with MV3

## Documentation

| Document | Description |
|----------|-------------|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Detailed project architecture |
| [docs/AI.md](./docs/AI.md) | Documentation for AI agents to understand and modify the project |
