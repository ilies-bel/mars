import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import {
  daemonPaths,
  isDaemonAlive,
  readDaemonPid,
  resolveLaunchCommand,
  tryConnectSocket,
} from './paths'
import { readLines, writeLine, type DaemonRequest, type DaemonResponse } from './protocol'
import { resolveContext } from '../context'
import { mapDaemonError } from './stale-detection'

const CONNECT_RETRY_INTERVAL_MS = 50
const CONNECT_TIMEOUT_MS = 5_000

interface ClientOptions {
  autoSpawn?: boolean
  onSpawnNotice?: (pid: number, logFile: string) => void
  /** Repo root override — when supplied, the daemon socket and spawn target
   *  are resolved under `<repo>/.mars/` rather than the CWD/MARS_REPO default. */
  repo?: string
}

const spawnDaemon = async (
  repo: string | undefined,
  onSpawnNotice?: (pid: number, logFile: string) => void,
): Promise<void> => {
  const { socket, logFile, pidFile } = daemonPaths(repo)
  const ctx = resolveContext(repo)
  const { command, baseArgs } = resolveLaunchCommand()

  const child = spawn(command, [...baseArgs, '--repo', ctx.repoRoot, 'daemon', 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MARS_REPO: ctx.repoRoot },
  })
  child.unref()

  const start = Date.now()
  while (Date.now() - start < CONNECT_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, CONNECT_RETRY_INTERVAL_MS))
    if (await tryConnectSocket(socket)) {
      const pid = readDaemonPid(pidFile) ?? child.pid ?? 0
      onSpawnNotice?.(pid, logFile)
      return
    }
  }
  throw new Error(
    `daemon did not come up within ${CONNECT_TIMEOUT_MS}ms (check ${logFile})`,
  )
}

const ensureRunning = async (opts: ClientOptions): Promise<void> => {
  const liveness = await isDaemonAlive(opts.repo)
  if (!liveness.alive) {
    if (opts.autoSpawn === false) {
      throw new Error(
        `mars daemon not running (${liveness.reason}) and auto-spawn disabled. Start it with: mars daemon start`,
      )
    }
    await spawnDaemon(opts.repo, opts.onSpawnNotice)
  }
}

export const sendRequest = async (
  req: DaemonRequest,
  opts: ClientOptions = {},
): Promise<unknown> => {
  await ensureRunning({ autoSpawn: false, ...opts })
  const { socket } = daemonPaths(opts.repo)

  return new Promise((resolve, reject) => {
    const sock = createConnection(socket)
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      sock.destroy()
      reject(err)
    }

    sock.once('error', fail)
    sock.once('connect', () => {
      readLines(sock, (line) => {
        if (settled) return
        try {
          const res = JSON.parse(line) as DaemonResponse
          settled = true
          sock.end()
          if (res.ok) {
            resolve(res.data)
          } else {
            // Rewrite stale-table (42P01 undefined_table) failures (e.g. a
            // daemon that predates the ideas->proposals rename and still
            // references the legacy `ideas` table) into an actionable restart
            // hint, so operators are never left staring at a raw database
            // error. Non-matching errors pass through unchanged.
            const e = new Error(mapDaemonError(res.error)) as Error & {
              code?: string
            }
            if (res.errorCode) e.code = res.errorCode
            reject(e)
          }
        } catch (err) {
          fail(err as Error)
        }
      })
      writeLine(sock, req)
    })
    sock.once('close', () => {
      if (!settled) fail(new Error('daemon closed connection without responding'))
    })
  })
}

const NO_DAEMON_QUESTION_MSG =
  'task ask: daemon not running — run `mars daemon start` (questions are raised through the daemon)'

export interface RaiseTaskQuestionOptions {
  /** Repo root override — resolves the http.port file under `<repo>/.mars/`
   *  rather than the CWD/MARS_REPO default. */
  repo?: string
}

/**
 * Raise a `task.question` outbox event for `taskId` via the daemon's HTTP API
 * (`POST /tasks/:id/question`). Backs `mars task ask`.
 *
 * This replaces the CLI process opening its own write transaction on the
 * state client via a dynamic import of outbox internals — the daemon is the
 * single writer; the CLI is purely an HTTP client of it (modular-core:
 * "move the CLI's outbox publish behind a daemon API").
 */
export const raiseTaskQuestion = async (
  taskId: string,
  question: string,
  opts: RaiseTaskQuestionOptions = {},
): Promise<void> => {
  const { httpPortFile } = daemonPaths(opts.repo)
  let port: number | null = null
  try {
    const raw = readFileSync(httpPortFile, 'utf8').trim()
    const parsed = Number(raw)
    port = Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    port = null
  }
  if (port === null) {
    throw new Error(NO_DAEMON_QUESTION_MSG)
  }

  let res: Response
  try {
    res = await fetch(
      `http://127.0.0.1:${port}/tasks/${encodeURIComponent(taskId)}/question`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      },
    )
  } catch {
    throw new Error(NO_DAEMON_QUESTION_MSG)
  }

  if (res.ok) return

  const body = (await res.json().catch(() => ({}))) as { error?: string }
  throw new Error(body.error ?? `daemon returned ${res.status}`)
}
