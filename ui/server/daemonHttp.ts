/**
 * Thin proxy from the read-only UI server to the daemon's local HTTP action
 * server. The daemon publishes its OS-assigned port to `.mars/http.port`; we
 * read it on demand and forward action requests to `127.0.0.1:<port>`.
 *
 * This is the ONLY write path the UI has: every recovery action a user clicks
 * is forwarded here, and the daemon — the single writer — performs the state
 * transition. The UI never mutates `mars.db` itself.
 *
 * The Failure-kind registry (the signature-keyed records bundling human reason,
 * recipe, and action menu) is also fetched from the daemon
 * (`GET /failure-kinds`) so the UI never imports orchestrator code: it stays a
 * standalone package that renders descriptors it's handed.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DAEMON_ERROR } from '../src/shared/daemonErrors.ts'

/** Mirror of the orchestrator's ActionDescriptor (received over the wire). */
export interface ActionDescriptor {
  id: string
  label: string
  op: string
  needsConfirm?: boolean
  hint?: string
}

/**
 * Mirror of the orchestrator's FailureKind record (received over the wire).
 * Keyed by the `<failingStep>/<error-class>` signature (ADR-0042).
 */
export interface FailureKind {
  signature: string
  warmTitle: string
  verboseReason: string
  recipe: string | null
  actions: ActionDescriptor[]
}

export interface DaemonActionResult {
  status: number
  body: unknown
}

const portFilePath = (stateDir: string): string => join(stateDir, 'http.port')

/**
 * Read the daemon's published HTTP port. Returns null when the daemon is not
 * running (no port file) or the file is malformed — callers surface a 503.
 */
export const readDaemonHttpPort = async (
  stateDir: string,
): Promise<number | null> => {
  try {
    const raw = (await readFile(portFilePath(stateDir), 'utf8')).trim()
    const port = Number(raw)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/**
 * Single owner of the daemon-connectivity envelope shared by every proxy fn:
 * read the published port, synthesize a 503 (`NO_DAEMON`) when the daemon is
 * not running, run the caller's fetch, and convert any transport throw into a
 * 502 (`PROXY_FAILED`). The wire-contract error codes are the same ones the
 * client maps to `ApiError.kind` (see `errorCodeToKind` in `shared/api.ts`).
 */
const withDaemon = async (
  stateDir: string,
  call: (port: number) => Promise<DaemonActionResult>,
): Promise<DaemonActionResult> => {
  const port = await readDaemonHttpPort(stateDir)
  if (port === null) {
    return {
      status: 503,
      body: { ok: false, error: 'daemon not running', errorCode: DAEMON_ERROR.NO_DAEMON },
    }
  }
  try {
    return await call(port)
  } catch (err) {
    // A connection-refused error means the port file is stale: the daemon exited
    // without removing it. Surface this as NO_DAEMON (503) — the same envelope
    // as a missing port file — so the UI shows "restart daemon" rather than a
    // generic proxy error.
    //
    // Node's fetch wraps the syscall error in `err.cause`; Bun may surface it
    // directly on `err`. Check both.
    const rawErr = err as { code?: string; cause?: { code?: string } }
    const errCode = rawErr.code ?? rawErr.cause?.code
    if (errCode === 'ECONNREFUSED') {
      return {
        status: 503,
        body: { ok: false, error: 'daemon not running', errorCode: DAEMON_ERROR.NO_DAEMON },
      }
    }
    return {
      status: 502,
      body: { ok: false, error: (err as Error).message, errorCode: DAEMON_ERROR.PROXY_FAILED },
    }
  }
}

/**
 * Fetch the signature-keyed Failure-kind registry from the daemon (ADR-0042).
 * Returns an empty list when the daemon is unreachable — the UI then renders
 * rows without action buttons rather than failing the whole actionQueue.
 */
export const fetchFailureKinds = async (
  stateDir: string,
): Promise<FailureKind[]> => {
  const port = await readDaemonHttpPort(stateDir)
  if (port === null) return []
  try {
    const res = await fetch(`http://127.0.0.1:${port}/failure-kinds`)
    if (!res.ok) return []
    const body = (await res.json()) as { failureKinds?: FailureKind[] }
    return Array.isArray(body.failureKinds) ? body.failureKinds : []
  } catch {
    return []
  }
}

/** Mirror of the orchestrator's KpiRecord (received over the wire). */
export interface KpiRecord {
  key: 'cost_per_arc' | 'failure_rate' | 'autonomous_completion_rate' | 'recovery_success_rate'
  currentValue: number
  priorValue: number
  delta: number
  sampleCount: number
  lowConfidence: boolean
}

/** Per-column KPI time-series returned by GET /kpis/series on the daemon. */
export interface KpiSeries {
  failure_rate: { takenAt: string; value: number | null }[]
  autonomous_completion_rate: { takenAt: string; value: number | null }[]
  recovery_success_rate: { takenAt: string; value: number | null }[]
  cost_per_arc_p50: { takenAt: string; value: number | null }[]
}

/**
 * Fetch the KPI vector from the daemon. Returns an empty array when the daemon
 * is unreachable — the UI then renders tiles in a loading/unavailable state
 * rather than failing the whole page.
 */
export const fetchKpis = async (stateDir: string): Promise<KpiRecord[]> => {
  const port = await readDaemonHttpPort(stateDir)
  if (port === null) return []
  try {
    const res = await fetch(`http://127.0.0.1:${port}/kpis`)
    if (!res.ok) return []
    const body = (await res.json()) as { kpis?: KpiRecord[] }
    return Array.isArray(body.kpis) ? body.kpis : []
  } catch {
    return []
  }
}

/**
 * Fetch the KPI time-series from the daemon (GET /kpis/series). Returns an
 * empty-series object when the daemon is unreachable — callers degrade
 * gracefully to empty sparkline data rather than failing the whole KPI tile.
 */
export const fetchKpiSeries = async (stateDir: string): Promise<KpiSeries> => {
  const empty: KpiSeries = {
    failure_rate: [],
    autonomous_completion_rate: [],
    recovery_success_rate: [],
    cost_per_arc_p50: [],
  }
  const port = await readDaemonHttpPort(stateDir)
  if (port === null) return empty
  try {
    const res = await fetch(`http://127.0.0.1:${port}/kpis/series`)
    if (!res.ok) return empty
    const body = (await res.json()) as { series?: KpiSeries }
    return body.series ?? empty
  } catch {
    return empty
  }
}

/**
 * Forward an arbitrary GET to the daemon, relaying its status + parsed JSON
 * body verbatim. Used by the actionQueue detail panel to surface the failure-reason
 * catalog, per-task trace events, and the origin tree. A missing daemon
 * yields a synthetic 503; a transport error yields a 502.
 */
export const proxyGet = async (
  stateDir: string,
  path: string,
): Promise<DaemonActionResult> =>
  withDaemon(stateDir, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`)
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  })

/**
 * Forward a POST or PUT with a JSON body to the daemon, relaying its status +
 * parsed JSON body verbatim. Used to forward actionQueue mutation verbs
 * (ack/resolve/dismiss) and preference writes to the daemon — the single writer
 * — so the UI no longer calls the state DB directly. A missing daemon yields a
 * synthetic 503; a transport error yields a 502.
 */
export const proxyPost = async (
  stateDir: string,
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
): Promise<DaemonActionResult> =>
  withDaemon(stateDir, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const responseBody = await res.json().catch(() => ({}))
    return { status: res.status, body: responseBody }
  })

/**
 * Stream a POST body (e.g. multipart/form-data) to the daemon without buffering
 * the entire body in memory. Preserves the incoming Content-Type header verbatim
 * so the multipart boundary is forwarded correctly.
 *
 * A missing daemon yields a synthetic 503; a transport error yields a 502.
 */
export const proxyStream = async (
  stateDir: string,
  path: string,
  req: Request,
): Promise<DaemonActionResult> =>
  withDaemon(stateDir, async (port) => {
    const ct = req.headers.get('Content-Type')
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: ct ? { 'Content-Type': ct } : {},
      body: req.body,
      // duplex: 'half' is required by some runtimes (Node ≥18) when the body
      // is a ReadableStream. Bun supports it natively without this option.
      duplex: 'half',
    })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  })

/**
 * Forward a DELETE request to the daemon, relaying its status + parsed JSON
 * body verbatim. Used for the un-teach learned-recipe route. A missing daemon
 * yields a synthetic 503; a transport error yields a 502.
 */
export const proxyDelete = async (
  stateDir: string,
  path: string,
): Promise<DaemonActionResult> =>
  withDaemon(stateDir, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE' })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  })

/**
 * Process-level action ops that have no entity scope.
 *
 * These ops target the daemon process itself rather than a specific task or
 * worktree, so the entity-id segment MUST be omitted from the path even if a
 * caller accidentally provides one. Belt-and-suspenders guard: the canonical
 * fix lives in ChatPage's `onRestart` wiring (which now uses the `restart-daemon`
 * verb instead of the legacy `restart` action), but `proxyAction` strips the id
 * here too so a stale caller can never produce a 404-inducing entity path.
 */
const PROCESS_LEVEL_ACTION_OPS = new Set(['restart-daemon', 'continue-all-daemon-killed'])

/**
 * Forward a recovery action to the daemon. `op` is the verb from the registry;
 * `entityId` is the task/worktree id (omitted for process-level ops like
 * `restart-daemon`). Returns the daemon's status + parsed body so the route can
 * relay it verbatim. A missing daemon yields a synthetic 503.
 */
export const proxyAction = async (
  stateDir: string,
  op: string,
  entityId?: string,
): Promise<DaemonActionResult> =>
  withDaemon(stateDir, async (port) => {
    // Process-level ops carry no entity scope — strip entityId unconditionally
    // to prevent the wrong /actions/<op>/<id> path from being built.
    const effectiveEntityId = PROCESS_LEVEL_ACTION_OPS.has(op) ? undefined : entityId
    const path =
      effectiveEntityId === undefined
        ? `/actions/${op}`
        : `/actions/${op}/${encodeURIComponent(effectiveEntityId)}`
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  })
