/**
 * `alert` command group: `list` (default) and `show <arc-id>`.
 *
 * Both read through the daemon's arc-rooted Alert endpoints (`GET /alerts`,
 * `GET /alerts/:arcId`) so the CLI and UI render the same pure derivation
 * (ADR-0054). The Alert read aggregate is never persisted — there is no row to
 * close and no operator-dismiss verb; an alert disappears only when the arc
 * leaves its failed state (or the stale worktree is gone). If the daemon is not
 * running, both commands fail fast — there is no fallback to the raw DB path.
 */

import type { Command } from '../command'
import type { Alert } from '../../core/lib/alert'
import { readDaemonPort } from './shared'

const NO_DAEMON_MSG =
  'alerts: daemon not running — run `mars daemon start` (the alert view is served by the daemon)'

const DAEMON_BUSY_MSG =
  'alerts: daemon did not answer within 2s (may be draining or busy — use `mars daemon status` to check)'

const ALERT_FETCH_TIMEOUT_MS = 2_000

/**
 * Map a fetch error to the appropriate user-visible message.
 *
 * Distinguishes three cases:
 * - Timeout / abort → daemon is up but slow (possibly draining); do NOT say
 *   "not running" since that prompts the operator to run `mars daemon start`
 *   against a daemon that is alive.
 * - Connection error (ECONNREFUSED / socket hang-up) → daemon stopped.
 * - Anything else → propagate as a generic error.
 */
const alertFetchErrorMessage = (err: unknown): string => {
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  ) {
    return DAEMON_BUSY_MSG
  }
  const socketError = /\b(ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b/
  const msg = err instanceof Error ? err.message : String(err)
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : ''
  if (socketError.test(msg) || socketError.test(code)) {
    return NO_DAEMON_MSG
  }
  if (err instanceof Error && /^daemon returned \d+$/.test(err.message)) {
    return `alerts: ${err.message}`
  }
  return DAEMON_BUSY_MSG
}

/** Fetch the full Alert list from the daemon. Throws on an unreachable daemon. */
const fetchAlerts = async (port: number): Promise<Alert[]> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ALERT_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/alerts`, { signal: controller.signal })
    if (!res.ok) throw new Error(`daemon returned ${res.status}`)
    return (await res.json()) as Alert[]
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch a single Alert by arc id. Returns null on a 404 (no alert for that
 * arc); throws on any other non-2xx so the caller can report an unreachable
 * daemon distinctly from a clean miss.
 */
const fetchAlert = async (
  port: number,
  arcId: string,
): Promise<Alert | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ALERT_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/alerts/${encodeURIComponent(arcId)}`,
      { signal: controller.signal },
    )
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`daemon returned ${res.status}`)
    return (await res.json()) as Alert
  } finally {
    clearTimeout(timer)
  }
}

/** Render the arc-rooted goal → reason → technical hierarchy for one alert. */
const renderAlert = (alert: Alert, out: (s: string) => void): void => {
  out(`arc:        ${alert.arcId}`)
  out(`kind:       ${alert.kind}`)
  out(`goal:       ${alert.goal}`)
  out(`reason:     ${alert.reason}`)
  out('technical:')
  for (const line of alert.technical.split('\n')) out(`  ${line}`)
}

/**
 * Render one arc-failed alert as a multi-line block that names the failing
 * tip, the recovery chain, the failure signature, and the blast radius
 * (blocked tasks downstream). This is the `mars alert list` display format.
 *
 * Format:
 *   <arcId>  <kind>  [blocks:<N>]
 *     goal:  <goal>
 *     tip:   <tipId> [(<tipLabel>, attempt <M>/<total>)] [phase=<failedPhase>]
 *     chain: <id1> → <id2> → …   ← only for arcs with > 1 task node
 *     why:   <signature> — <reason>
 *
 * Exported for unit-testing the rendering without an HTTP daemon.
 */
export const renderArcAlertBlock = (
  alert: Alert,
  out: (s: string) => void,
): void => {
  // Header: arc id, kind, and blast radius (omit "blocks:0" — unremarkable).
  const blocksLabel =
    typeof alert.blockedCount === 'number' && alert.blockedCount > 0
      ? `  blocks:${alert.blockedCount}`
      : ''
  out(`${alert.arcId}  ${alert.kind}${blocksLabel}`)

  // Goal.
  out(`  goal: ${alert.goal}`)

  // Identify the tip: the last task-kind chain node with status='failed', or
  // the last task-kind node when none is explicitly failed.
  const taskNodes = alert.chain.filter((n) => n.kind === 'task')
  const tip =
    [...taskNodes].reverse().find((n) => n.status === 'failed') ??
    taskNodes[taskNodes.length - 1]

  if (tip) {
    const isFixTask = tip.id.startsWith('fix-')
    const fixNodes = taskNodes.filter((n) => n.id.startsWith('fix-'))
    const fixTotal = fixNodes.length
    // Attempt label: for fix tasks, M/total where M is position in fix list.
    const fixIndex = fixNodes.indexOf(tip)
    const attemptLabel =
      isFixTask && fixTotal > 0
        ? ` (fix, attempt ${fixIndex + 1}/${fixTotal})`
        : tip.attemptIndex !== undefined
          ? ` (attempt ${tip.attemptIndex})`
          : ''
    const phaseLabel =
      alert.failedPhase != null && alert.failedPhase.length > 0
        ? `  phase=${alert.failedPhase}`
        : ''
    out(`  tip:  ${tip.id}${attemptLabel}${phaseLabel}`)
  }

  // Chain: only render when there are multiple task-kind nodes (a chain of one
  // is just the origin repeated, which adds no information).
  if (taskNodes.length > 1) {
    out(`  chain: ${taskNodes.map((n) => n.id).join(' → ')}`)
  }

  // Why: signature + reason on a single line.
  const sig = alert.failureSignature ?? ''
  const why = sig.length > 0 ? `${sig} — ${alert.reason}` : alert.reason
  out(`  why:  ${why}`)
}

const alertList: Command = {
  path: 'alert list',
  summary: 'list arc-rooted alerts (failed arcs + stale worktrees)',
  usage: 'usage: mars alert list',
  run: async (_args, deps) => {
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let alerts: Alert[]
    try {
      alerts = await fetchAlerts(port)
    } catch (err) {
      deps.err(alertFetchErrorMessage(err))
      return { code: 1 }
    }
    if (alerts.length === 0) {
      deps.out('no alerts')
      return { code: 0 }
    }
    for (const alert of alerts) {
      if (alert.kind === 'arc-failed') {
        renderArcAlertBlock(alert, deps.out)
      } else {
        // stale-worktree and verify-uncovered: flat single-line format.
        deps.out(`${alert.arcId}\t${alert.kind}\t${alert.goal}\t${alert.reason}`)
      }
    }
    return { code: 0 }
  },
}

/**
 * The bare `alert` (no subcommand) is an alias for `alert list`.
 */
const alertDefault: Command = {
  path: 'alert',
  summary: 'list arc-rooted alerts (alias for `alert list`)',
  usage: 'usage: mars alert [list | show <arc-id>]',
  run: (args, deps) => alertList.run(args, deps),
}

const alertShow: Command = {
  path: 'alert show',
  summary: 'show one arc-rooted alert (goal → reason → technical)',
  usage: 'usage: mars alert show <arc-id>',
  run: async (args, deps) => {
    const arcId = args.positional[0]
    if (!arcId) {
      deps.err('usage: mars alert show <arc-id>')
      return { code: 2 }
    }
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let alert: Alert | null
    try {
      alert = await fetchAlert(port, arcId)
    } catch (err) {
      deps.err(alertFetchErrorMessage(err))
      return { code: 1 }
    }
    if (alert === null) {
      deps.err(`no alert for arc ${arcId}`)
      return { code: 1 }
    }
    renderAlert(alert, deps.out)
    return { code: 0 }
  },
}

export const alertCommands: readonly Command[] = [
  alertList,
  alertShow,
  alertDefault,
]
