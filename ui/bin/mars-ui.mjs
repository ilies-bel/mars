#!/usr/bin/env node
import { spawn } from 'node:child_process'
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
  --dev           Run in development mode (API + Vite dev server)
  --repo <path>   Path to the Mars repo (default: auto-detected)
  --port <n>      HTTP port (default: 7777)
  --host <addr>   Bind address (default: 127.0.0.1)
  --help          Show this help`)
  process.exit(0)
}

const isDev = argv.includes('--dev')

// Strip --dev before forwarding args to the server process
const serverArgv = argv.filter((a) => a !== '--dev')

if (isDev) {
  // Dev mode: spawn the API server + vite concurrently.
  // --dist is intentionally omitted; vite serves the frontend.
  const server = spawn('bun', ['--watch', 'run', serverEntry, ...serverArgv], {
    stdio: 'inherit',
    env: process.env,
  })

  const viteBin = resolve(pkgRoot, 'node_modules/.bin/vite')
  const viteCmd = existsSync(viteBin) ? viteBin : 'npx'
  const viteArgs = existsSync(viteBin) ? [] : ['vite']
  const vite = spawn(viteCmd, viteArgs, {
    stdio: 'inherit',
    cwd: pkgRoot,
    env: process.env,
  })

  let exiting = false
  const killAll = (signal) => {
    if (exiting) return
    exiting = true
    try { server.kill(signal) } catch { /* already gone */ }
    try { vite.kill(signal) } catch { /* already gone */ }
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

  vite.on('error', (err) => {
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

  server.on('exit', (code) => {
    killAll('SIGINT')
    process.exit(code ?? 0)
  })

  vite.on('exit', (code) => {
    killAll('SIGINT')
    process.exit(code ?? 0)
  })
} else {
  // Production mode: require dist/ to be present.
  if (!existsSync(distDir)) {
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
