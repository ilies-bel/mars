import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync, readFileSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
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

export const resolveLauncher = (repoRoot?: string): string | null => {
  const here = dirname(fileURLToPath(import.meta.url))
  // Segment that identifies a path living inside a worktree checkout.
  // Any candidate containing this segment is skipped — serving a worktree's
  // UI build is never correct and produces confusing 404s.
  const worktreeSegment = `${sep}.mars${sep}worktrees${sep}`

  const candidates: string[] = []
  // Repo-root candidate comes first — preferred over script-relative fallbacks.
  if (repoRoot) {
    candidates.push(resolve(repoRoot, 'ui/bin/mars-ui.mjs'))
  }
  // Script-relative fallbacks for packaged / global installs where the
  // launcher lives next to the CLI binary rather than under a repo.
  candidates.push(
    resolve(here, '../../../ui/bin/mars-ui.mjs'),
    resolve(here, '../../ui/bin/mars-ui.mjs'),
  )

  for (const candidate of candidates) {
    if (candidate.includes(worktreeSegment)) {
      process.stderr.write(`[mars ui] skipping worktree launcher: ${candidate}\n`)
      continue
    }
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
  // Resolve repo context first so we can pass repoRoot to resolveLauncher,
  // ensuring the repo-root UI package is preferred over any worktree copy.
  const ctx = resolveContext(opts.repo)
  const launcher = resolveLauncher(ctx.repoRoot)
  if (!launcher) {
    console.error(
      'ui package not found; run `cd ui && npm install` or reinstall mars',
    )
    process.exit(1)
  }

  const port = opts.port ? parseInt(opts.port, 10) : 7777
  const host = opts.host ?? '127.0.0.1'
  const logFile = resolve(ctx.stateDir, 'ui.log')
  // Open the log file for appending before spawning so the child inherits
  // a valid, open fd from the very first byte it writes.
  const logFd = openSync(logFile, 'a')

  const args: string[] = []
  if (opts.repo) args.push('--repo', opts.repo)
  if (opts.port) args.push('--port', opts.port)
  if (opts.host) args.push('--host', opts.host)
  if (opts.dev) args.push('--dev')

  // Spawn detached with stdio redirected to the log file (not the tty).
  //
  // detached: true — the child becomes the leader of a new process group, so
  //   it is not killed by SIGHUP when the launching shell closes.
  // stdio: ['ignore', logFd, logFd] — disconnecting stdin from the tty
  //   prevents the kernel from sending SIGHUP when the tty hangs up.
  // child.unref() — the parent's event loop no longer waits for the child,
  //   allowing the CLI to exit 0 immediately and leave the server running.
  const child = spawn(process.execPath, [launcher, ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  // Parent no longer needs its copy of the fd — the child has inherited its own.
  closeSync(logFd)
  child.unref()

  const pidFile = getPidFilePath(opts.repo)
  const entry: UiPidEntry = {
    pid: child.pid!,
    port,
    host,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(pidFile, JSON.stringify(entry, null, 2))

  process.stdout.write(
    `mars-ui  starting (pid=${child.pid})\n` +
      `         url=http://${host}:${port}\n` +
      `         log=${logFile}\n`,
  )
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
