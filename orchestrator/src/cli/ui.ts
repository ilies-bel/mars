import { spawn } from 'node:child_process'
import {
  existsSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveContext } from '../core/context'
import { stopProcess, makeOsStopDeps } from './ui-stop'

interface LaunchOptions {
  repo?: string
  port?: string
  host?: string
  dev?: boolean
  /** Vite dev-server port. Forwarded as --vite-port to mars-ui.mjs; null = auto-select. */
  vitePort?: string
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

  const ctx = resolveContext(opts.repo)
  const logFile = resolve(ctx.stateDir, 'ui.log')
  // The child's stdout/stderr are this file, not pipes back to us.
  //
  // Piping was a latent kill-switch. This process exits as soon as it has
  // printed the banner, which closes the read ends; the detached server was
  // then left holding write ends with no reader (`lsof` shows the socket peer
  // as `->(none)`), so its very next log line took it down. Observed twice in
  // one session: server healthy on :7777, gone minutes later, with the
  // advertised log file empty because nothing was ever written to it.
  //
  // A real fd has neither problem — it survives our exit, and the log the
  // banner points at now actually contains the server's output.
  const logFd = openSync(logFile, 'a')
  const logStartOffset = fstatSync(logFd).size

  const args: string[] = []
  if (opts.repo) args.push('--repo', opts.repo)
  if (opts.port) args.push('--port', opts.port)
  if (opts.host) args.push('--host', opts.host)
  if (opts.dev) args.push('--dev')
  if (opts.vitePort) args.push('--vite-port', opts.vitePort)

  // Readiness signal: the banner is printed only after the child confirms a
  // successful bind ("listening on <url>") or we learn it failed. We read that
  // out of the log file the child is writing to.
  //
  // We prefer this over port-polling (avoids a timing gap between the OS bind
  // and the first successful HTTP probe) and over Node IPC (would require
  // adding process.send() to ui/server/index.ts).
  //
  // detached: true — child leads its own process group; survives parent exit.
  // stdin 'ignore' — no tty, so no SIGHUP when the launching shell closes.
  // stdout/stderr → logFd — see the note on logFd above; pipes here left the
  // detached server writing into a closed pipe once this process exited.
  const child = spawn(process.execPath, [launcher, ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  // The child holds its own duplicate of the descriptor; ours is done.
  closeSync(logFd)

  type Outcome =
    | { ok: true; url: string }
    | { ok: false; message: string; exitedZero: boolean }

  /** Everything the child has written to the log since we spawned it. */
  const readChildLog = (): string => {
    try {
      const fd = openSync(logFile, 'r')
      try {
        const size = fstatSync(fd).size
        if (size <= logStartOffset) return ''
        const buf = Buffer.allocUnsafe(size - logStartOffset)
        readSync(fd, buf, 0, buf.length, logStartOffset)
        return buf.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return ''
    }
  }

  const outcome = await new Promise<Outcome>((resolve) => {
    let settled = false

    const settle = (result: Outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      resolve(result)
    }

    // Guard against a hung child. Two budgets, because "slow" and "hung" are
    // different: a normal start binds in well under a second, but a start that
    // has to rebuild a stale bundle first runs `tsc -b && vite build && tsc`,
    // which takes tens of seconds on a cold cache.
    //
    // The child announces the rebuild before it begins, so we extend the
    // deadline on evidence rather than raising it blindly — a genuinely hung
    // child still fails fast at 10s.
    const START_TIMEOUT_MS = 10_000
    const BUILD_TIMEOUT_MS = 180_000

    let timeoutMs = START_TIMEOUT_MS
    const onTimeout = (): void => {
      settle({
        ok: false,
        message: `mars-ui: timed out waiting for server to start (${Math.round(timeoutMs / 1000)}s)`,
        exitedZero: false,
      })
    }
    let timer = setTimeout(onTimeout, timeoutMs)

    const poll = setInterval(() => {
      const log = readChildLog()
      // Rebuilding — this start is legitimately slow, not stuck.
      if (timeoutMs === START_TIMEOUT_MS && /bundle is stale — rebuilding/.test(log)) {
        timeoutMs = BUILD_TIMEOUT_MS
        clearTimeout(timer)
        timer = setTimeout(onTimeout, timeoutMs)
        process.stderr.write(
          'mars-ui: frontend bundle is stale — rebuilding, this can take a minute…\n',
        )
      }
      const m = log.match(/listening on (http:\/\/\S+)/)
      if (m) settle({ ok: true, url: m[1] })
    }, 100)

    child.on('exit', (code) => {
      if (settled) return
      const log = readChildLog().trim()
      if (code === 0) {
        // "already running" case: server exits 0 with a message.
        if (log) process.stdout.write(log + '\n')
        settle({ ok: false, message: '', exitedZero: true })
      } else {
        settle({
          ok: false,
          message: log || `mars-ui: server exited with code ${code}`,
          exitedZero: false,
        })
      }
    })
  })

  child.unref()

  if (!outcome.ok) {
    if (outcome.exitedZero) return  // "already running" — message already forwarded
    process.stderr.write(outcome.message + '\n')
    process.exit(1)
  }

  // Parse host and port from the advertised URL so the pid entry always reflects
  // what is actually reachable — in dev mode this is the Vite port, not 7777.
  const pidFile = getPidFilePath(opts.repo)
  const parsedUrl = new URL(outcome.url)
  const entry: UiPidEntry = {
    pid: child.pid!,
    port: parseInt(parsedUrl.port, 10),
    host: parsedUrl.hostname,
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
