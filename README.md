# PlayChrome

Chrome extension sidepanel notebook para manipular el DOM de cualquier página usando **Playwright real** via WebSocket.

## Requisitos

| Requisito | Versión | Notas |
|-----------|---------|-------|
| **Sistema operativo** | macOS (Apple Silicon o Intel) | Linux compatible con cambios en rutas (ver docs) |
| **Google Chrome** | 149+ | Canary, Dev, Beta o Stable |
| **Node.js** | 20+ | Incluye npm |

> **Playwright**: No necesitas instalar browsers (`npx playwright install`). El servidor usa `playwright-core` que se conecta a tu Chrome ya instalado via CDP — no descarga browsers adicionales.

## Instalación

### 1. Instalar Node.js (si no lo tienes)

```bash
# Opción A — Homebrew (recomendado)
brew install node

# Opción B — nvm (si necesitas múltiples versiones)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22

# Opción C — Descargar desde https://nodejs.org (v20 LTS o superior)
```

Verifica:
```bash
node --version   # → v20.x.x o superior
npm --version    # → 10.x.x o superior
```

### 2. Clonar e instalar dependencias

```bash
cd playchrome
npm --prefix server install
```

Esto instala `playwright-core` y `ws` dentro de `server/node_modules/`. No necesita `sudo`.

### 3. Cargar la extensión en Chrome

1. Abre `chrome://extensions/` en Chrome
2. Activa **"Developer mode"** (toggle en esquina superior derecha)
3. Click **"Load unpacked"**
4. Selecciona la carpeta `playchrome` (la raíz del proyecto)
5. Verás la tarjeta **PlayChrome** en la lista de extensiones
6. Fíjala en la barra de herramientas (click en el icono de puzzle → pin PlayChrome)

> ⚠️ La extensión usa `sidePanel` API (Chrome 114+). Si el icono no abre el sidepanel, verifica que estés en Chrome 114+ y reinicia Chrome.

## Cómo usar

### Uso rápido (recomendado)

```bash
# 1. Listar perfiles disponibles
node server/index.js --os mac --profiles

# 2. Iniciar servidor + Chrome con tu perfil (todo en uno)
node server/index.js --os mac --profile "Profile 1"
```

El servidor lanza Chrome automáticamente, se conecta via CDP y muestra solo la consola en vivo.

### Uso manual (server + Chrome por separado)

```bash
# 1. Arrancar el servidor
node server/index.js

# 2. Copia el comando que imprime el servidor para tu perfil
#    y ejecútalo en otra terminal:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-allow-origins="*" \
  --user-data-dir="$HOME/.playchrome" \
  --profile-directory="Profile 1" \
  --no-first-run \
  about:blank

> Chrome 149+ **requiere** un `--user-data-dir` no-default para habilitar CDP.
> El servidor crea `~/.playchrome` con symlinks a tus perfiles reales.
```

### 3. Conectar la extensión

- Navega a la página que quieras manipular
- Click en el icono de PlayChrome en la barra de extensiones
- Click **Connect**
- Escribe código Playwright en las celdas del notebook

### Variables disponibles en las celdas

| Variable | Descripción |
|----------|-------------|
| `page` | Página activa de Playwright (`Page` object) |
| `browser` | Instancia del navegador (`Browser` object) |

### Ejemplos

```javascript
// Navegar y obtener título
await page.goto('https://example.com');
return await page.title();

// Extraer texto
return await page.evaluate(() => document.body.innerText);

// Click en un elemento
await page.locator('button.submit').click();

// Capturar screenshot (devuelve base64)
return await page.screenshot({ encoding: 'base64' });
```

## Atajos de teclado

| Atajo | Acción |
|-------|--------|
| `Ctrl+Enter` | Ejecutar celda |
| `Shift+Enter` | Ejecutar y crear nueva celda |
| `Ctrl+Shift+Enter` | Crear nueva celda |

## Flags del servidor

| Flag | Ejemplo | Descripción |
|------|---------|-------------|
| `--os <sistema>` | `--os mac` | Sistema operativo: `mac`, `linux`, `win` |
| `--profile <dir>` | `--profile "Profile 1"` | Inicia servidor + Chrome con ese perfil (modo silencioso) |
| `--profiles` | `--profiles` | Lista perfiles y comandos, no inicia el servidor |

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto del servidor WebSocket |
| `CDP_PORT` | `9222` | Puerto CDP de Chrome |

## Arquitectura

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

Para documentación detallada, ver [`docs/`](./docs/).

## Limitaciones

- **Sistema**: desarrollado y probado en macOS. Linux requiere cambiar `CHROME_PATH` y `CHROME_DIR` en `server/index.js` (ver [docs/AI.md](./docs/AI.md#soportar-linux))
- **Windows**: no soportado actualmente (rutas hardcodeadas a macOS)
- **Chrome 149+**: requiere `--remote-debugging-port` y `--user-data-dir` no-default
- **Un solo servidor**: una instancia del servidor maneja todas las conexiones WebSocket
- **Código corre en Node.js**: las celdas se ejecutan en el servidor (no en la página). Usar `page.evaluate()` para código en contexto de página
- **Sin `unsafe-eval`**: se usa `new Function()` en el servidor (no en la extensión), compatible con MV3

## Documentación

| Documento | Descripción |
|-----------|-------------|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Arquitectura detallada del proyecto |
| [docs/AI.md](./docs/AI.md) | Documentación para que una IA entienda y manipule el proyecto |
