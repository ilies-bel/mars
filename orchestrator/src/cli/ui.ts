import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContext } from '../core/context'
import { stopProcess, makeOsStopDeps } from './ui-stop'

interface LaunchOptions {
  repo?: string
  port?: string
  host?: string
  dev?: boolean
}

export interface UiPidEntry {
  pid: number
  port: number
  host: string
  startedAt: string
}

export const resolveLauncher = (): string | null => {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '../../../ui/bin/mars-ui.mjs'),
    resolve(here, '../../ui/bin/mars-ui.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export const printUiDiscoveryHint = (repoRoot: string, launcher: string | null): void => {
  if (launcher !== null) {
    process.stdout.write(
      `[mars init] dashboard:  mars ui --repo ${repoRoot}   (read-only Kanban + trace stream at http://127.0.0.1:7777)\n`,
    )
  } else {
    process.stdout.write(
      `[mars init] dashboard not available: UI package not found — build it with: cd ui && npm install && npm run build\n`,
    )
  }
}

export const getPidFilePath = (repo?: string): string => {
  const ctx = resolveContext(repo)
  return resolve(ctx.stateDir, 'ui.pid.json')
}

export const readPidEntry = (repo?: string): UiPidEntry | null => {
  const pidFile = getPidFilePath(repo)
  if (!existsSync(pidFile)) return null
  try {
    return JSON.parse(readFileSync(pidFile, 'utf8')) as UiPidEntry
  } catch {
    return null
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const launchUi = (opts: LaunchOptions): void => {
  const launcher = resolveLauncher()
  if (!launcher) {
    console.error(
      'ui package not found; run `cd ui && npm install` or reinstall mars',
    )
    process.exit(1)
  }

  const port = opts.port ? parseInt(opts.port, 10) : 7777
  const host = opts.host ?? '127.0.0.1'

  const args: string[] = []
  if (opts.repo) args.push('--repo', opts.repo)
  if (opts.port) args.push('--port', opts.port)
  if (opts.host) args.push('--host', opts.host)
  if (opts.dev) args.push('--dev')

  const child = spawn(process.execPath, [launcher, ...args], {
    stdio: 'inherit',
    env: process.env,
  })

  const pidFile = getPidFilePath(opts.repo)
  const entry: UiPidEntry = {
    pid: child.pid!,
    port,
    host,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(pidFile, JSON.stringify(entry, null, 2))

  child.on('exit', (code) => {
    try {
      unlinkSync(pidFile)
    } catch {
      // already gone — ignore
    }
    process.exit(code ?? 0)
  })
  child.on('error', (err) => {
    try {
      unlinkSync(pidFile)
    } catch {
      // already gone — ignore
    }
    console.error(`failed to launch mars ui: ${err.message}`)
    process.exit(1)
  })
}

export const statusUi = (repo?: string): void => {
  const entry = readPidEntry(repo)
  if (!entry || !isAlive(entry.pid)) {
    console.log('not running')
    return
  }
  console.log(`pid=${entry.pid}  port=${entry.port}  url=http://${entry.host}:${entry.port}`)
}

export const stopUi = async (repo?: string): Promise<void> => {
  const pidFile = getPidFilePath(repo)
  const entry = readPidEntry(repo)

  const result = await stopProcess(entry, pidFile, makeOsStopDeps())

  if (result.kind === 'not-running') {
    console.log('no ui running')
  } else {
    console.log(`stopped pid=${result.pid}  port=${result.port}`)
  }
  process.exit(0)
}
