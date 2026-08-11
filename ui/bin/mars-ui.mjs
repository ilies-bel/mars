#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const distDir = resolve(pkgRoot, 'dist')
const serverEntry = resolve(pkgRoot, 'server/index.ts')

const argv = [...process.argv.slice(2)]

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: mars-ui [options]

Start the Mars dashboard server.

Options:
  --dev              Run in development mode (API + Vite dev server)
  --repo <path>      Path to the Mars repo (default: auto-detected)
  --port <n>         API server HTTP port (default: 7777, fixed)
  --vite-port <n>    Vite dev-server port (--dev only; default: auto-selects from 5173
                     on the --host address; an IPv6-only holder of [::1]:5173 does not
                     cause a shift — only 127.0.0.1:5173 being taken triggers fallback)
  --host <addr>      Bind address (default: 127.0.0.1)
  --help             Show this help`)
  process.exit(0)
}

const isDev = argv.includes('--dev')

// Parse --vite-port (wrapper-only; not forwarded to the server process).
// Lets users pin a specific Vite port when the auto-selected one is inconvenient.
let vitePort = null
const vitePortIdx = argv.indexOf('--vite-port')
if (vitePortIdx !== -1) {
  const rawPort = argv[vitePortIdx + 1]
  const n = Number(rawPort)
  if (isNaN(n) || n < 1 || n > 65535) {
    console.error(`mars-ui: invalid --vite-port "${rawPort}" — must be a number between 1 and 65535`)
    process.exit(1)
  }
  vitePort = n
}

// Build serverArgv: forward all flags to the server process except --vite-port
// and its value (which the server does not understand).  In particular, --dev IS
// forwarded so the server enters development mode (no static-file serving, no
// stale-bundle check).
const serverArgv = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--vite-port') {
    i++ // skip the value too
    continue
  }
  serverArgv.push(argv[i])
}

if (isDev) {
  // Determine the host and API port that will be used by the API server child.
  const hostIdx = argv.indexOf('--host')
  const viteHost = hostIdx !== -1 && argv[hostIdx + 1] ? argv[hostIdx + 1] : '127.0.0.1'
  const portIdx = argv.indexOf('--port')
  const apiPort = portIdx !== -1 && argv[portIdx + 1] ? parseInt(argv[portIdx + 1], 10) : 7777

  // Choose the Vite port.
  //
  // Probe viteHost:5173 specifically — this matches server.host in vite.config.ts
  // (default: 127.0.0.1). Vite never attempts a dual-stack bind when server.host is
  // set to an explicit IPv4 address, so a holder of [::1]:5173 is NOT a conflict and
  // must NOT trigger a port shift. We bind the probe to viteHost so the OS sees the
  // same address Vite would use.
  let usedVitePort = vitePort  // explicit --vite-port wins, skip auto-selection
  if (usedVitePort === null) {
    const is5173Free = await new Promise((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.listen(5173, viteHost, () => srv.close(() => resolve(true)))
    })
    if (is5173Free) {
      usedVitePort = 5173
    } else {
      usedVitePort = await new Promise((resolvePort, rejectPort) => {
        const srv = createServer()
        srv.once('error', rejectPort)
        srv.listen(0, viteHost, () => {
          const addr = srv.address()
          srv.close(() => resolvePort(addr.port))
        })
      })
    }
  }

  // Spawn the API server with piped stdout/stderr so we can intercept its
  // "listening on" line and rewrite it before it reaches ui.ts's readiness regex.
  // All output is tee'd to our own stdout/stderr so nothing is lost.
  const server = spawn('bun', ['--watch', 'run', serverEntry, ...serverArgv], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })

  // Build Vite's env: set MARS_UI_API_BASE for the dev-server proxy, and explicitly
  // never set VITE_API_BASE. VITE_API_BASE is inlined into the client bundle by Vite's
  // default env-prefix handling, which would flip every /api fetch from relative
  // (same-origin, through the proxy) to cross-origin (directly to :7777, skipping CORS
  // that the API server only partially implements). MARS_UI_API_BASE is server-side only
  // and never escaped into the bundle.
  const viteEnv = Object.assign({}, process.env)
  viteEnv['MARS_UI_API_BASE'] = `http://${viteHost}:${apiPort}`
  delete viteEnv['VITE_API_BASE']

  const viteBin = resolve(pkgRoot, 'node_modules/.bin/vite')
  const viteCmd = existsSync(viteBin) ? viteBin : 'npx'
  const viteBaseArgs = existsSync(viteBin) ? [] : ['vite']

  // killAll closes both children. vite is assigned after the spawn loop below;
  // let-binding captures the live reference even when it's null at declaration time.
  let vite = null
  let exiting = false
  const killAll = (signal) => {
    if (exiting) return
    exiting = true
    try { server.kill(signal) } catch { /* already gone */ }
    if (vite) { try { vite.kill(signal) } catch { /* already gone */ } }
  }

  process.on('SIGINT', () => killAll('SIGINT'))
  process.on('SIGTERM', () => killAll('SIGTERM'))

  server.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(
        'mars-ui: bun not found on PATH. Install Bun (https://bun.sh) and re-run.',
      )
      killAll('SIGTERM')
      process.exit(127)
    }
    console.error(`mars-ui: failed to spawn bun: ${err.message}`)
    killAll('SIGTERM')
    process.exit(1)
  })

  // Tee API server stdout, rewriting the "listening on http://..." line so that
  // ui.ts's readiness regex does not settle on the API port. The wrapper itself
  // signals readiness (with the Vite port) once Vite is ready.
  server.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    process.stdout.write(text.replace(/listening on (http:\/\/\S+)/g, 'mars-ui  api on $1'))
  })
  server.stderr.on('data', (chunk) => process.stderr.write(chunk))

  server.on('exit', (code) => {
    killAll('SIGINT')
    process.exit(code ?? 0)
  })

  // Spawn Vite, retrying on bind errors (TOCTOU race between the probe-close above
  // and Vite's own bind). Up to MAX_VITE_RETRIES additional attempts after the first.
  const MAX_VITE_RETRIES = 3

  for (let attempt = 0; attempt <= MAX_VITE_RETRIES; attempt++) {
    let viteBindFail = false
    let viteReady = false

    await new Promise((resolveAttempt) => {
      const child = spawn(viteCmd, [...viteBaseArgs, '--port', String(usedVitePort)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: pkgRoot,
        env: viteEnv,
      })
      vite = child
      let viteOutputBuf = ''

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString()
        process.stdout.write(chunk)
        if (!viteReady) {
          viteOutputBuf += text
          // Vite prints "Local:" in its startup banner once the server is accepting
          // connections. This is the reliable readiness signal.
          if (viteOutputBuf.includes('Local:')) {
            viteReady = true
            resolveAttempt()
          }
        }
      })
      child.stderr.on('data', (chunk) => {
        viteOutputBuf += chunk.toString()  // accumulate for bind-error detection
        process.stderr.write(chunk)
      })
      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          console.error(
            'mars-ui: vite not found. Run `npm --prefix <ui-dir> install` and re-run.',
          )
          killAll('SIGTERM')
          process.exit(127)
        }
        console.error(`mars-ui: failed to spawn vite: ${err.message}`)
        killAll('SIGTERM')
        process.exit(1)
      })
      child.on('exit', (code) => {
        if (viteReady) return  // already settled; exit after readiness is handled below
        viteBindFail =
          viteOutputBuf.includes('EADDRINUSE') ||
          viteOutputBuf.includes('address already in use') ||
          viteOutputBuf.includes('is already in use')
        resolveAttempt()
      })
    })

    if (viteReady) break

    if (!viteBindFail || attempt === MAX_VITE_RETRIES) {
      // Non-bind failure or retries exhausted — no recovery possible.
      killAll('SIGTERM')
      process.exit(1)
    }

    // Re-probe for a fresh free port on the same host.
    usedVitePort = await new Promise((resolvePort, rejectPort) => {
      const srv = createServer()
      srv.once('error', rejectPort)
      srv.listen(0, viteHost, () => {
        const addr = srv.address()
        srv.close(() => resolvePort(addr.port))
      })
    })
  }

  // Vite is now ready and accepting connections. Signal ui.ts's readiness watcher.
  // The regex in ui.ts is /listening on (http:\/\/\S+)/ — this line matches it and
  // carries the Vite port so ui.ts writes the correct URL to the pid file.
  process.stdout.write(`listening on http://${viteHost}:${usedVitePort}\n`)

  // After readiness, if Vite exits unexpectedly, tear down the whole wrapper.
  vite.on('exit', (code) => {
    killAll('SIGINT')
    process.exit(code ?? 0)
  })
} else {
  // Production mode: require dist/index.html to be present before binding a
  // port. Checking the directory alone is insufficient — an empty dist/ passes
  // the directory test but causes the server to serve 404s for every request.
  const distIndex = resolve(distDir, 'index.html')
  if (!existsSync(distIndex)) {
    console.error(
      'mars-ui: frontend is not built.\n' +
        `  Run \`npm --prefix ${pkgRoot} run build\` first, then retry.`,
    )
    process.exit(1)
  }

  if (!serverArgv.includes('--dist')) {
    serverArgv.push('--dist', distDir)
  }

  const child = spawn('bun', ['run', serverEntry, ...serverArgv], {
    stdio: 'inherit',
    env: process.env,
  })
  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(
        'mars-ui: bun not found on PATH. Install Bun (https://bun.sh) and re-run.',
      )
      process.exit(127)
    }
    console.error(`mars-ui: failed to spawn bun: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}
