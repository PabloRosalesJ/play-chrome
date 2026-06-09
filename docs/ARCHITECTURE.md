# Arquitectura de PlayChrome

## Visión general

PlayChrome es un notebook REPL en el sidepanel de Chrome que ejecuta código Playwright real contra la página activa del navegador. La extensión se comunica via WebSocket con un servidor Node.js local que se conecta a Chrome mediante Chrome DevTools Protocol (CDP).

## Componentes

### 1. Extensión Chrome (MV3)

```
manifest.json          → Manifest V3, permissions: sidePanel, storage
service-worker.js       → Abre el sidepanel al hacer click en el icono
sidepanel.html          → UI principal (toolbar, celdas, footer)
sidepanel.js            → Lógica: WebSocket, celdas, autocomplete, resultados
lib/notebook-core.js    → CRUD de celdas, persistencia en localStorage
styles.css              → Tema oscuro, estilos de celdas/outputs/toasts
vendor/codemirror/      → CodeMirror 5.65.16 (core, JS mode, hint addon)
```

#### Flujo de la extensión

1. `service-worker.js` — al hacer click en el icono, abre el sidepanel via `chrome.sidePanel.open()`
2. `sidepanel.html` carga los scripts en orden: CodeMirror → notebook-core → sidepanel.js
3. `sidepanel.js::init()` — restaura celdas del notebook, bindea eventos del toolbar
4. Usuario click **Connect** → WebSocket a `ws://127.0.0.1:3000`
5. Al abrir WebSocket, envía `{ type: 'CONNECT' }` al servidor
6. Si Chrome CDP no está disponible, servidor responde con ERROR → la extensión muestra `chrome-launcher` con instrucciones
7. Si CONNECT exitoso, servidor responde `{ type: 'CONNECTED', pages: [...] }`
8. La extensión rellena el `#page-selector` con las páginas/tabs disponibles
9. Usuario elige una página del selector → envía `{ type: 'SELECT_PAGE', index }`
10. Usuario escribe código en una celda CodeMirror y click ▶ o `Ctrl+Enter`
11. La extensión envía `{ type: 'EVAL', id, code }` al servidor
12. Servidor ejecuta el código con Playwright, devuelve `{ type: 'RESULT', id, result }`
13. La extensión renderiza el resultado en el output de la celda

#### Mensajes WebSocket

| Tipo (cliente → servidor) | Descripción |
|--------------------------|-------------|
| `CONNECT` | Conectar a Chrome via CDP |
| `EVAL { id, code }` | Ejecutar código Playwright |
| `LIST_PAGES { id }` | Listar páginas/tabs activas |
| `SELECT_PAGE { id, index }` | Seleccionar página activa |
| `GET_PROFILES { id }` | Listar perfiles de Chrome |
| `PING { id }` | Health check |

| Tipo (servidor → cliente) | Descripción |
|--------------------------|-------------|
| `CONNECTED { pages }` | Conexión exitosa, lista de páginas |
| `RESULT { id, result }` | Resultado de evaluación |
| `ERROR { id, error }` | Error |
| `PROFILES { id, profiles }` | Lista de perfiles detectados |
| `PAGES { id, pages }` | Lista de páginas actualizada |
| `PAGE_SELECTED { id, index }` | Página seleccionada |
| `PONG { id }` | Health check response |

### 2. Servidor Node.js

```
server/
  package.json       → Dependencias: playwright-core, ws
  index.js           → Servidor HTTP + WebSocket, conexión CDP, evaluación de código
```

#### Archivo: `server/index.js`

**Responsabilidades:**
- Servir WebSocket en `ws://127.0.0.1:3000`
- Conectar a Chrome via `playwright-core.chromium.connectOverCDP()`
- Ejecutar código JavaScript arbitrario usando `new Function()`
- Detectar perfiles de Chrome en `~/Library/Application Support/Google/Chrome/`
- Inicializar `~/.playchrome` con symlinks a los perfiles reales

**Funciones principales:**

| Función | Descripción |
|---------|-------------|
| `getProfiles()` | Escanea `CHROME_DIR` en busca de subdirectorios `Default` / `Profile N`, lee `Preferences` para obtener nombre visible |
| `initPlayChromeDir()` | Crea `PLAYCHROME_DIR` (`~/.playchrome`) y crea symlinks a los perfiles reales de Chrome |
| `getChromeCommand(profile)` | Genera el comando shell para lanzar Chrome con un perfil específico y CDP habilitado |
| `connectToChrome()` | Cierra conexión anterior (si existe), conecta via `chromium.connectOverCDP()` a `http://127.0.0.1:9222` |
| `getPagesInfo()` | Obtiene lista de páginas abiertas del primer browser context |
| `selectPage(index)` | Cambia la página activa |
| `evaluate(code)` | Ejecuta código en el servidor con acceso a `page` y `browser`, captura console.log de página y servidor |
| `handleMessage(ws, msg)` | Router de mensajes WebSocket |

**Evaluación de código:**
```javascript
const fn = new Function('page', 'browser', `
  return (async () => {
    ${code}
  })()
`)
const raw = await fn(activePage, browser)
```

El código corre en Node.js con las variables `page` (Playwright Page) y `browser` (Playwright Browser) inyectadas. Para operar en el contexto de la página web, usar `page.evaluate()`.

**Captura de console:**
- Page-side: `page.on('console')` captura mensajes de `console.log` dentro de `page.evaluate()`
- Server-side: override temporal de `console.log`/`warn`/`error` para capturar logs del código del usuario
- Ambos se combinan y devuelven con el resultado

### 3. Conexión CDP

Chrome debe iniciarse con:
- `--remote-debugging-port=9222`
- `--remote-allow-origins="*"` (requerido Chrome 112+)
- `--user-data-dir=<ruta-no-default>` (requerido Chrome 149+)

Playwright se conecta via `chromium.connectOverCDP('http://127.0.0.1:9222')` que internamente:
1. Hace GET a `http://127.0.0.1:9222/json/version` para obtener el WebSocket URL
2. Conecta via WebSocket al endpoint CDP
3. Expone `browser.contexts()` y `context.pages()` con las páginas existentes

### 4. Manejo de perfiles

Chrome 149+ **no permite** `--remote-debugging-port` con el `--user-data-dir` por defecto (`~/Library/Application Support/Google/Chrome`). Solución:

1. El servidor crea `~/.playchrome/` en el startup
2. Crea symlinks de los perfiles reales (Default, Profile 1, etc.) dentro de `~/.playchrome/`
3. El usuario lanza Chrome con `--user-data-dir=$HOME/.playchrome --profile-directory="Profile 1"`
4. Chrome ve un `--user-data-dir` no-default y permite CDP
5. Los datos del perfil se leen del symlink → es el perfil real del usuario

## Flujo de datos

```
Usuario escribe código en celda CodeMirror
  → click ▶ o Ctrl+Enter
    → sidepanel.js::executeCell(cellId)
      → validate connected + ws open
      → sidepanel.js::evaluateOnServer(code)
        → envía { type: 'EVAL', id, code } via WebSocket
          → server/index.js::handleMessage()
            → server/index.js::evaluate(code)
              → new Function('page', 'browser', 'return (async () => { ... })()')
                → Playwright ejecuta en Chrome real
              → captura console.log (page + server)
              → devuelve { value, console }
            → envía { type: 'RESULT', id, result } via WebSocket
          → sidepanel.js::handleServerMessage()
            → resolvePending(msg)
              → sidepanel.js::formatResult()
                → sidepanel.js::renderOutput()
                  → Renderiza en .cell-output
```

## Dependencias

### Servidor (`server/package.json`)
- `playwright-core` ^1.52.0 — sin browser binaries (usa `connectOverCDP`)
- `ws` ^8.18.0 — WebSocket server

### Extensión (vendors)
- CodeMirror 5.65.16 — editor de código en las celdas
- Sin dependencias externas de npm o bundlers

## Variables de entorno

| Variable | Default | Propósito |
|----------|---------|-----------|
| `PORT` | `3000` | Puerto del servidor WebSocket |
| `CDP_PORT` | `9222` | Puerto CDP de Chrome |

## Constantes del servidor

```javascript
CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
CHROME_DIR = '~/Library/Application Support/Google/Chrome'
PLAYCHROME_DIR = '~/.playchrome'
CDP_TIMEOUT = 8000       // ms
CONSOLE_DELAY = 80       // ms — espera para capturar console.log
```
