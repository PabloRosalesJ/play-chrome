# PlayChrome — Documentación para AI

Este documento describe el proyecto PlayChrome para que cualquier agente de IA pueda entender su estructura, propósito y cómo modificarlo sin romperlo.

## ¿Qué es PlayChrome?

PlayChrome es un **notebook interactivo** dentro del sidepanel de Chrome que permite ejecutar código **Playwright** directamente contra la página que el usuario tiene abierta. Es como un Jupyter notebook, pero para manipular el DOM del navegador con el Playwright API completo.

### Caso de uso

Un usuario está en `https://midomini.com/admin/usuarios` y quiere:
- Extraer datos de una tabla
- Hacer click en botones
- Llenar formularios
- Tomar screenshots

En vez de abrir DevTools y escribir JavaScript, usa PlayChrome que le da acceso al API completo de Playwright.

## Estructura del proyecto

```
playchrome/
├── manifest.json           → Chrome Extension MV3 manifest
├── service-worker.js       → Service worker (abre sidepanel)
├── sidepanel.html          → UI del sidepanel
├── sidepanel.js            → Lógica del sidepanel (~562 lines)
├── styles.css              → Tema oscuro
├── lib/
│   └── notebook-core.js    → Persistencia de celdas (localStorage)
├── server/
│   ├── package.json        → Dependencias del servidor
│   ├── index.js            → Servidor WebSocket + Playwright (~240 lines)
│   └── node_modules/       → playwright-core, ws
├── vendor/
│   └── codemirror/         → CodeMirror 5.65.16 (editor)
└── docs/
    ├── ARCHITECTURE.md     → Arquitectura detallada
    └── AI.md               → Este archivo
```

## Convenciones del código

### Generales
- Sin comentarios en el código (a menos que sea estrictamente necesario)
- Variables en camelCase
- Funciones asíncronas con `async/await`
- Errores se limpian con `cleanError()` (strip ANSI codes)
- Mensajes WebSocket son JSON con campo `type`

### Servidor (`server/index.js`)
- Estado global mutable: `browser`, `activePage`, `chromeProcess`, `wsClients`
- WebSocket server HTTP en puerto `PORT` (default 3000)
- Conexión CDP a `http://127.0.0.1:CDP_PORT` (default 9222)
- Evaluación de código via `new Function('page', 'browser', 'return (async () => { ... })()')`
- `page` y `browser` son variables globales disponibles en toda celda. `page` = pestaña activa, `browser` = BrowserContext.
- `prepareUserCode()` remueve `let/const/var/function/class` del inicio de línea para que las variables persistan como globales entre celdas (tipo Jupyter).
- NO usa `eval()` — usa `new Function()` que es menos restrictivo
- Console.log de página capturado via `page.on('console')`
- Console.log de servidor capturado via override temporal de `console.log`

### Extensión (`sidepanel.js`)
- WebSocket client con reconnect manual
- Celdas del notebook: CodeMirror 5 con hinting custom
- Notebook persistido en localStorage via `lib/notebook-core.js`
- Resultados renderizados como HTML en `.cell-output`
- `evalPending` Map para correlacionar requests/responses

### Extension Service Worker (`service-worker.js`)
- Mínimo: solo abre el sidepanel al hacer click en el icono

## Reglas críticas

### NO hacer
1. **NO matar Chrome** — el servidor nunca debe matar procesos de Chrome
2. **NO auto-lanzar Chrome** — el usuario lanza Chrome manualmente con el comando provisto
3. **NO usar `eval()` en la extensión** — MV3 no permite `unsafe-eval`. `new Function()` solo en el servidor
4. **NO cambiar el `--user-data-dir` por defecto** — Chrome 149 requiere uno no-default para CDP; usar `~/.playchrome` con symlinks
5. **NO asumir que Chrome está en una ruta específica** — validar con `fs.existsSync()`

### Sí hacer
1. Limpiar errores con `cleanError()` antes de enviar al cliente
2. Timeout en conexiones CDP (8s) para no colgar el servidor
3. Capturar console.log de ambos lados (page + server)
4. Restaurar console.log original en el `finally` de evaluate()
5. Cerrar browser anterior antes de reconectar en `connectToChrome()`
6. Crear `~/.playchrome` con symlinks en el startup

## Cómo modificar el proyecto

### Agregar un nuevo tipo de mensaje WebSocket

**Servidor** (`server/index.js`):
1. Agregar case en `handleMessage()` switch
2. Implementar la lógica
3. Enviar respuesta con `ws.send(JSON.stringify({ type: 'NUEVO_TIPO', ... }))`

**Extensión** (`sidepanel.js`):
1. Enviar mensaje con `sendToServer({ type: 'NUEVO_TIPO', id, ... })`
2. Agregar case en `handleServerMessage()` switch
3. Procesar respuesta

### Agregar un hint de autocomplete

En `sidepanel.js::makeHint()`, array `hints`:
```javascript
const hints = [
  // ... existentes
  'page.nuevoMetodo',  // <-- agregar aquí
]
```

### Cambiar el puerto CDP

```bash
CDP_PORT=9223 node server/index.js
```

### Soportar otro navegador

En `server/index.js`, cambiar `chromium` por `firefox` o `webkit` de `playwright-core`:
```javascript
const { chromium, firefox, webkit } = require('playwright-core')
// Usar firefox.connectOverCDP(cdpUrl)
```

### Soportar Linux

Cambiar `CHROME_PATH`:
```javascript
const CHROME_PATH = '/usr/bin/google-chrome'  // Linux
const CHROME_DIR = path.join(process.env.HOME || '', '.config/google-chrome')
```

## Pruebas

El proyecto no tiene test suite formal. Para probar:

```bash
# Probar servidor
node server/index.js

# En otra terminal, probar conexión WebSocket:
node -e '
const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:3000");
ws.on("open", () => ws.send(JSON.stringify({type:"CONNECT", id:"test"})));
ws.on("message", (d) => { console.log(JSON.parse(d)); ws.close(); });
'

# Probar EVAL (después de conectar Chrome con CDP):
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

## Perfiles de Chrome

El servidor detecta perfiles en `~/Library/Application Support/Google/Chrome/` filtrando por nombre `Default` o `Profile N`. Lee `Preferences` → `profile.name` para el nombre visible.

**IMPORTANTE**: Cada perfil tiene un `--profile-directory` distinto. No confundir el nombre visible (ej. "Personal") con el nombre del directorio (ej. "Profile 2").

## Chrome 149+ y CDP

Chrome 149 introdujo un cambio: `--remote-debugging-port` **no funciona** con el `--user-data-dir` por defecto. El servidor resuelve esto:
1. Crea `~/.playchrome/` en startup
2. Symlink de los perfiles reales ahí dentro
3. El usuario lanza Chrome apuntando a `~/.playchrome`

Si en el futuro Chrome revierte esto, se puede eliminar `initPlayChromeDir()` y usar directamente `CHROME_DIR`.

## Glosario

| Término | Significado |
|---------|-------------|
| CDP | Chrome DevTools Protocol — protocolo para controlar Chrome programáticamente |
| `connectOverCDP` | Método de Playwright que conecta a un Chrome ya iniciado via CDP |
| Browser Context | Aislamiento de sesiones en Playwright (equivalente a una ventana de incógnito) |
| Sidepanel | Panel lateral de Chrome Extension MV3 |
| MV3 | Manifest V3 — versión actual del modelo de extensiones Chrome |
