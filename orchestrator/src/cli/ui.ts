import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync, readFileSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContext } from '../core/context'
import { stopProcess, makeOsStopDeps } from './ui-stop'

type StreamWithUnref = { unref?: () => void; removeAllListeners: (event: string) => unknown; resume: () => unknown }

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

export const launchUi = async (opts: LaunchOptions): Promise<void> => {
  const launcher = resolveLauncher()
  if (!launcher) {
    console.error(
      'ui package not found; run `cd ui && npm install` or reinstall mars',
    )
    process.exit(1)
  }

  const port = opts.port ? parseInt(opts.port, 10) : 7777
  const host = opts.host ?? '127.0.0.1'
  const ctx = resolveContext(opts.repo)
  const logFile = resolve(ctx.stateDir, 'ui.log')
  // Touch the log file so the path shown in the banner always resolves even
  // though the child's output now travels through pipes instead of this fd.
  const logFd = openSync(logFile, 'a')
  closeSync(logFd)

  const args: string[] = []
  if (opts.repo) args.push('--repo', opts.repo)
  if (opts.port) args.push('--port', opts.port)
  if (opts.host) args.push('--host', opts.host)
  if (opts.dev) args.push('--dev')

  // Readiness signal: we pipe stdout and stderr so the banner is only printed
  // after the child confirms a successful bind ("listening on <url>" on stdout)
  // or we learn it failed (non-zero exit with a message on stderr).
  //
  // We prefer this over port-polling (avoids a timing gap between the OS bind
  // and the first successful HTTP probe) and over Node IPC (would require
  // adding process.send() to ui/server/index.ts).
  //
  // detached: true — child leads its own process group; survives parent exit.
  // stdin 'ignore' — no tty, so no SIGHUP when the launching shell closes.
  const child = spawn(process.execPath, [launcher, ...args], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })

  type Outcome =
    | { ok: true; url: string }
    | { ok: false; message: string; exitedZero: boolean }

  const outcome = await new Promise<Outcome>((resolve) => {
    let stdoutBuf = ''
    let stderrBuf = ''
    let settled = false

    const settle = (result: Outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // 10-second guard against a hung child.
    const timer = setTimeout(() => {
      settle({
        ok: false,
        message: 'mars-ui: timed out waiting for server to start (10s)',
        exitedZero: false,
      })
    }, 10_000)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk
      const m = stdoutBuf.match(/listening on (http:\/\/\S+)/)
      if (m) settle({ ok: true, url: m[1] })
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf += chunk
    })

    child.on('exit', (code) => {
      if (settled) return
      if (code === 0) {
        // "already running" case: server exits 0 with a message on stdout.
        const msg = stdoutBuf.trim()
        if (msg) process.stdout.write(msg + '\n')
        settle({ ok: false, message: '', exitedZero: true })
      } else {
        const msg = stderrBuf.trim() || `mars-ui: server exited with code ${code}`
        settle({ ok: false, message: msg, exitedZero: false })
      }
    })
  })

  // Drain and unref the streams: keep the pipes open so the running child
  // does not get EPIPE, but stop buffering and release from the event loop.
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    stream.removeAllListeners('data')
    stream.resume()
    ;(stream as unknown as StreamWithUnref).unref?.()
  }
  child.unref()

  if (!outcome.ok) {
    if (outcome.exitedZero) return  // "already running" — message already forwarded
    process.stderr.write(outcome.message + '\n')
    process.exit(1)
  }

  // Only print the success banner after the child has confirmed it is bound.
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
      `         url=${outcome.url}\n` +
      `         log=${logFile}\n`,
  )
}

/** Injectable seams for {@link statusUi}. Production passes nothing. */
export interface StatusUiDeps {
  /** Probe the root path of the advertised URL. Defaults to global fetch. */
  probeFetch?: (url: string, signal: AbortSignal) => Promise<Response>
}

export const statusUi = async (repo?: string, deps: StatusUiDeps = {}): Promise<void> => {
  const entry = readPidEntry(repo)
  if (!entry || !isAlive(entry.pid)) {
    console.log('not running')
    return
  }

  const baseUrl = `http://${entry.host}:${entry.port}`
  const doFetch = deps.probeFetch ?? ((url, signal) => fetch(url, { signal }))

  let unhealthyReason: string | null = null
  try {
    const resp = await doFetch(`${baseUrl}/`, AbortSignal.timeout(2_000))
    if (!resp.ok) {
      unhealthyReason = `root path returned ${resp.status}`
    }
  } catch (err) {
    unhealthyReason = (err as Error).message
  }

  if (unhealthyReason === null) {
    console.log(`pid=${entry.pid}  port=${entry.port}  url=${baseUrl}`)
  } else {
    console.log(
      `pid=${entry.pid}  port=${entry.port}  url=${baseUrl}  status=unhealthy  reason=${unhealthyReason}`,
    )
  }
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
