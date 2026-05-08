import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { daemonPaths, isProcessAlive, resolveLaunchCommand } from './paths'
import { readLines, writeLine, type DaemonRequest, type DaemonResponse } from './protocol'
import { resolveContext } from '../context'

const CONNECT_RETRY_INTERVAL_MS = 50
const CONNECT_TIMEOUT_MS = 5_000

interface ClientOptions {
  autoSpawn?: boolean
  onSpawnNotice?: (pid: number, logFile: string) => void
}

const tryConnect = async (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = createConnection(socketPath)
    sock.once('connect', () => {
      sock.end()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })

const readPid = (pidFile: string): number | null => {
  if (!existsSync(pidFile)) return null
  try {
    const raw = readFileSync(pidFile, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

const reclaimStale = (): void => {
  const { socket, pidFile } = daemonPaths()
  const pid = readPid(pidFile)
  if (pid !== null && isProcessAlive(pid)) return
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile)
    } catch {
      // best-effort
    }
  }
  if (existsSync(socket)) {
    try {
      unlinkSync(socket)
    } catch {
      // best-effort
    }
  }
}

const spawnDaemon = async (
  onSpawnNotice?: (pid: number, logFile: string) => void,
): Promise<void> => {
  const { socket, logFile } = daemonPaths()
  const ctx = resolveContext()
  const { command, baseArgs } = resolveLaunchCommand()

  const child = spawn(command, [...baseArgs, '--repo', ctx.repoRoot, 'watch'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MARS_REPO: ctx.repoRoot },
  })
  child.unref()

  const start = Date.now()
  while (Date.now() - start < CONNECT_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, CONNECT_RETRY_INTERVAL_MS))
    if (existsSync(socket) && (await tryConnect(socket))) {
      const pidFile = daemonPaths().pidFile
      const pid = readPid(pidFile) ?? child.pid ?? 0
      onSpawnNotice?.(pid, logFile)
      return
    }
  }
  throw new Error(
    `daemon did not come up within ${CONNECT_TIMEOUT_MS}ms (check ${logFile})`,
  )
}

const ensureRunning = async (opts: ClientOptions): Promise<void> => {
  const { socket } = daemonPaths()
  reclaimStale()
  if (existsSync(socket) && (await tryConnect(socket))) return
  if (opts.autoSpawn === false) {
    throw new Error(
      `mars daemon not running and auto-spawn disabled. Start it with: mars watch`,
    )
  }
  await spawnDaemon(opts.onSpawnNotice)
}

export const sendRequest = async (
  req: DaemonRequest,
  opts: ClientOptions = {},
): Promise<unknown> => {
  await ensureRunning({ autoSpawn: true, ...opts })
  const { socket } = daemonPaths()

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
          if (res.ok) resolve(res.data)
          else reject(new Error(res.error))
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
