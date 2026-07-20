/**
 * Embedded PostgreSQL provisioning (migration 0002 §1).
 *
 * The daemon owns exactly one PostgreSQL instance per repo:
 * - data dir `.mars/pg/data`, bound to `127.0.0.1` on an OS-assigned port,
 *   `trust` auth on loopback, superuser `mars`, database `mars`.
 * - After the server is ready, `.mars/pg.port` (port number) and
 *   `.mars/pg.dsn` (`postgres://mars@127.0.0.1:<port>/mars`) are published —
 *   the same pattern as `.mars/http.port`. Consumers read the file, never
 *   guess.
 * - Provisioning is idempotent/reusing: if `postmaster.pid` in the data dir
 *   names a live postmaster whose port answers, that server is adopted
 *   instead of starting a second one. This covers daemon-restart overlap AND
 *   the crashed-daemon orphan case (a daemon that died without stopping its
 *   postmaster leaves a perfectly healthy server behind — we reconnect to
 *   it, we never kill-and-restart it, so no in-flight consumer loses its DB).
 * - The postgres child is spawned in the daemon's process group on purpose:
 *   `mars daemon kill`'s SIGKILL-the-group takes the postmaster down with
 *   it, and PG's own WAL recovery handles the unclean stop on next boot.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

export const PG_USER = 'mars'
export const PG_DATABASE = 'mars'
export const PG_HOST = '127.0.0.1'

// ── Pure helpers (unit-tested without PG binaries) ──────────────────────────

export interface PostmasterPidInfo {
  pid: number
  port: number
}

/**
 * Parses a PostgreSQL `postmaster.pid` file. Format (one field per line):
 * pid, data dir, start epoch, port, socket dir, listen addr, shmem key,
 * status. Returns null when the content does not look like a pid file
 * (corrupt / truncated files are treated as stale).
 */
export function parsePostmasterPid(content: string): PostmasterPidInfo | null {
  const lines = content.split(/\r?\n/)
  const pid = Number.parseInt(lines[0] ?? '', 10)
  const port = Number.parseInt(lines[3] ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { pid, port }
}

export interface ProvisioningProbe {
  /** Parsed postmaster.pid, or null when absent/corrupt. */
  pidFile: PostmasterPidInfo | null
  /** Whether the pid named in the pid file is a live process. */
  pidAlive: boolean
  /** Whether the port named in the pid file accepts TCP connections. */
  portAnswers: boolean
}

export type ProvisioningDecision =
  | { action: 'adopt'; port: number }
  | { action: 'start'; clearStalePidFile: boolean }

/**
 * The adopt-vs-start decision. Adopt only when all three signals agree
 * (pid file present, its process alive, its port accepting) — anything less
 * means the pid file is stale (crashed postmaster, or an unrelated process
 * that recycled the pid) and must be cleared so the fresh postmaster does
 * not refuse to boot on a leftover lock file.
 */
export function decideProvisioning(probe: ProvisioningProbe): ProvisioningDecision {
  if (probe.pidFile !== null && probe.pidAlive && probe.portAnswers) {
    return { action: 'adopt', port: probe.pidFile.port }
  }
  return { action: 'start', clearStalePidFile: probe.pidFile !== null }
}

/** The canonical DSN for the embedded server (trust auth — no password). */
export function buildDsn(port: number): string {
  return `postgres://${PG_USER}@${PG_HOST}:${port}/${PG_DATABASE}`
}

/**
 * Publishes `.mars/pg.port` and `.mars/pg.dsn`. Must only be called AFTER
 * the server answers: the dsn file is the readiness signal every consumer
 * trusts. Port first, dsn last — a reader that sees pg.dsn can rely on
 * pg.port existing too.
 */
export async function publishPgFiles(stateDir: string, port: number): Promise<string> {
  const dsn = buildDsn(port)
  await writeFile(join(stateDir, 'pg.port'), String(port))
  await writeFile(join(stateDir, 'pg.dsn'), dsn)
  return dsn
}

/** True when `pid` names a live process (EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Attempts a TCP connection to 127.0.0.1:port within `timeoutMs`. */
export function probeTcp(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: PG_HOST, port })
    const done = (answered: boolean): void => {
      socket.destroy()
      resolve(answered)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Asks the OS for a currently-free loopback port. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, PG_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('pg-server: could not determine a free port'))
        return
      }
      const { port } = address
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

// ── Provisioning ────────────────────────────────────────────────────────────

export interface StartEmbeddedPgOptions {
  /** The repo's `.mars` directory. Data lands in `<stateDir>/pg/data`. */
  stateDir: string
  /** Log sink for postgres/initdb output (the daemon passes its log()). */
  onLog?: (message: string) => void
}

export interface EmbeddedPgHandle {
  dsn: string
  port: number
  /** True when an already-running postmaster was adopted instead of started. */
  adopted: boolean
  /**
   * Stops the server IF this call started it. For an adopted server this is
   * a no-op: the adopted postmaster is either still owned by an overlapping
   * daemon (restart window — killing it would yank the DB out from under
   * live consumers) or a deliberate orphan whose data must stay live for
   * the next boot to re-adopt. `mars daemon kill`'s process-group SIGKILL
   * plus PG WAL recovery remain the backstop for orphans.
   */
  stop(): Promise<void>
}

const ADOPT_PROBE_ATTEMPTS = 3
const ADOPT_PROBE_DELAY_MS = 500

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function probeExistingServer(dataDir: string): Promise<ProvisioningProbe> {
  let pidFile: PostmasterPidInfo | null = null
  try {
    pidFile = parsePostmasterPid(await readFile(join(dataDir, 'postmaster.pid'), 'utf8'))
  } catch {
    // Absent pid file — nothing to adopt.
  }
  if (pidFile === null) return { pidFile: null, pidAlive: false, portAnswers: false }
  const pidAlive = isPidAlive(pidFile.pid)
  let portAnswers = false
  if (pidAlive) {
    // A postmaster mid-boot (WAL recovery) may not accept yet; give it a
    // short, bounded window before declaring the pid file stale.
    for (let attempt = 0; attempt < ADOPT_PROBE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(ADOPT_PROBE_DELAY_MS)
      portAnswers = await probeTcp(pidFile.port)
      if (portAnswers) break
    }
  }
  return { pidFile, pidAlive, portAnswers }
}

/** Creates the `mars` database if this cluster does not have it yet. */
async function ensureMarsDatabase(port: number): Promise<void> {
  const client = new pg.Client({
    host: PG_HOST,
    port,
    user: PG_USER,
    database: 'postgres',
  })
  await client.connect()
  try {
    const existing = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [PG_DATABASE],
    )
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(PG_DATABASE)}`)
    }
  } finally {
    await client.end()
  }
}

/**
 * Ensures the repo's embedded PostgreSQL server is running and published.
 *
 * Adopt-or-start: an existing live postmaster (per `postmaster.pid`) is
 * adopted; otherwise the data dir is initialised on first use (initdb) and a
 * fresh postmaster is started on an OS-assigned port. `.mars/pg.port` /
 * `.mars/pg.dsn` are (re-)published only after the server answers.
 */
export async function startEmbeddedPg(
  options: StartEmbeddedPgOptions,
): Promise<EmbeddedPgHandle> {
  const { stateDir } = options
  const onLog = options.onLog ?? ((): void => {})
  const dataDir = join(stateDir, 'pg', 'data')
  await mkdir(dataDir, { recursive: true })

  const decision = decideProvisioning(await probeExistingServer(dataDir))
  if (decision.action === 'adopt') {
    // Re-publish unconditionally: a crashed daemon may have unlinked the
    // port/dsn files while the orphaned server kept running.
    const dsn = await publishPgFiles(stateDir, decision.port)
    return { dsn, port: decision.port, adopted: true, stop: async () => {} }
  }

  if (decision.clearStalePidFile) {
    // Dead pid (or a recycled pid that is not listening): postgres would
    // refuse to start over the leftover lock file.
    await rm(join(dataDir, 'postmaster.pid'), { force: true })
  }

  const port = await findFreePort()
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: PG_USER,
    // trust auth on loopback (design 0002 §1) — the password is never used.
    // The published types omit 'trust' but the value is passed verbatim to
    // `initdb --auth=`.
    password: PG_USER,
    authMethod: 'trust' as unknown as 'password',
    persistent: true,
    postgresFlags: ['-c', `listen_addresses=${PG_HOST}`],
    onLog,
    onError: (message: unknown) => onLog(String(message)),
  })

  // PG_VERSION marks an initialised data dir; initdb must run exactly once.
  const initialised = await readFile(join(dataDir, 'PG_VERSION'), 'utf8')
    .then(() => true)
    .catch(() => false)
  if (!initialised) {
    await instance.initialise()
  }
  try {
    // start() resolves on "ready to accept connections"; on early exit it
    // rejects with undefined — normalize to a real error.
    await instance.start()
  } catch (err: unknown) {
    throw err instanceof Error
      ? err
      : new Error(`pg-server: postgres exited before becoming ready (data dir ${dataDir})`)
  }
  await ensureMarsDatabase(port)
  const dsn = await publishPgFiles(stateDir, port)
  return {
    dsn,
    port,
    adopted: false,
    stop: () => instance.stop(),
  }
}
