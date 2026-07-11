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

/** Fetch the full Alert list from the daemon. Throws on an unreachable daemon. */
const fetchAlerts = async (port: number): Promise<Alert[]> => {
  const res = await fetch(`http://127.0.0.1:${port}/alerts`)
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as Alert[]
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
  const res = await fetch(
    `http://127.0.0.1:${port}/alerts/${encodeURIComponent(arcId)}`,
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as Alert
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
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    if (alerts.length === 0) {
      deps.out('no alerts')
      return { code: 0 }
    }
    for (const alert of alerts) {
      deps.out(`${alert.arcId}\t${alert.kind}\t${alert.goal}\t${alert.reason}`)
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
    } catch {
      deps.err(NO_DAEMON_MSG)
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
