/**
 * Thin proxy from the read-only UI server to the daemon's local HTTP action
 * server. The daemon publishes its OS-assigned port to `.mars/http.port`; we
 * read it on demand and forward action requests to `127.0.0.1:<port>`.
 *
 * This is the ONLY write path the UI has: every recovery action a user clicks
 * is forwarded here, and the daemon — the single writer — performs the state
 * transition. The UI never mutates `mars.db` itself.
 *
 * The error-kind registry (the action menus) is also fetched from the daemon
 * (`GET /error-kinds`) so the UI never imports orchestrator code: it stays a
 * standalone package that renders descriptors it's handed.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Mirror of the orchestrator's ActionDescriptor (received over the wire). */
export interface ActionDescriptor {
  id: string
  label: string
  op: string
  needsConfirm?: boolean
  hint?: string
}

/** Mirror of the orchestrator's ErrorKind entity (received over the wire). */
export interface ErrorKind {
  kind: string
  rowKind: string
  trigger: string
  recipe: string
  recoveryActions: ActionDescriptor[]
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
 * Fetch the error-kind registry from the daemon. Returns an empty list when the
 * daemon is unreachable — the UI then renders rows without action buttons
 * rather than failing the whole inbox.
 */
export const fetchErrorKinds = async (
  stateDir: string,
): Promise<ErrorKind[]> => {
  const port = await readDaemonHttpPort(stateDir)
  if (port === null) return []
  try {
    const res = await fetch(`http://127.0.0.1:${port}/error-kinds`)
    if (!res.ok) return []
    const body = (await res.json()) as { errorKinds?: ErrorKind[] }
    return Array.isArray(body.errorKinds) ? body.errorKinds : []
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
 * Forward an arbitrary GET to the daemon, relaying its status + parsed JSON
 * body verbatim. Used by the inbox detail panel to surface the failure-reason
 * catalog, per-task trace events, and the origin tree. A missing daemon
 * yields a synthetic 503; a transport error yields a 502.
 */
export const proxyGet = async (
  stateDir: string,
  path: string,
): Promise<DaemonActionResult> => {
  const port = await readDaemonHttpPort(stateDir)
  if (port === null) {
    return {
      status: 503,
      body: { ok: false, error: 'daemon not running', errorCode: 'NO_DAEMON' },
    }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`)
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  } catch (err) {
    return {
      status: 502,
      body: { ok: false, error: (err as Error).message, errorCode: 'PROXY_FAILED' },
    }
  }
}

/**
 * Forward a POST with a JSON body to the daemon, relaying its status + parsed
 * JSON body verbatim. Used to forward inbox mutation verbs (ack/resolve/dismiss)
 * to the daemon — the single writer — so the UI no longer calls the state DB
 * directly. A missing daemon yields a synthetic 503; a transport error yields a
 * 502.
 */
export const proxyPost = async (
  stateDir: string,
  path: string,
  body: unknown,
): Promise<DaemonActionResult> => {
  const port = await readDaemonHttpPort(stateDir)
  if (port === null) {
    return {
      status: 503,
      body: { ok: false, error: 'daemon not running', errorCode: 'NO_DAEMON' },
    }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const responseBody = await res.json().catch(() => ({}))
    return { status: res.status, body: responseBody }
  } catch (err) {
    return {
      status: 502,
      body: { ok: false, error: (err as Error).message, errorCode: 'PROXY_FAILED' },
    }
  }
}

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
): Promise<DaemonActionResult> => {
  const port = await readDaemonHttpPort(stateDir)
  if (port === null) {
    return {
      status: 503,
      body: { ok: false, error: 'daemon not running', errorCode: 'NO_DAEMON' },
    }
  }
  const path =
    entityId === undefined
      ? `/actions/${op}`
      : `/actions/${op}/${encodeURIComponent(entityId)}`
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    return { status: res.status, body }
  } catch (err) {
    return {
      status: 502,
      body: { ok: false, error: (err as Error).message, errorCode: 'PROXY_FAILED' },
    }
  }
}
