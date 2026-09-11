/**
 * `action-queue` command group: `list` (default), `show`, `raise`
 * (JSON on stdin/file), `watch`, and `reconcile`.
 *
 * `list`, `show`, and the bare `action-queue` alias read through the daemon's
 * `GET /view/action-queue` endpoint so the CLI and UI always render the same
 * derived view (`buildActionQueueView`). If the daemon is not running, both
 * commands fail fast — there is no fallback to the raw DB path.
 *
 * The action queue is a pure projection (ADR-0048). There is no
 * operator-facing gesture that closes a row — the Invalidator is the sole
 * row-closer, driven by domain events.
 *
 * --lean is a boolean flag that lands in positionals after routing.
 */

import { readFileSync } from 'node:fs'
import { raiseActionQueueItem, ACTION_QUEUE_KINDS, isActionQueueKind } from '../../core/lib/action-queue'
import { actionQueueRaiseSchema } from '../action-queue-raise-schema'
import { hasFlag } from '../args'
import type { Command, CommandDeps } from '../command'
import { errorMessage, readDaemonPort } from './shared'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'
import type { ActionQueueGroupedRow } from '../../core/daemon/view/action-queue-group'
import { formatGroupRowTsv } from '../action-queue-group'

const LEAN_PREVIEW = 3

/**
 * Operator-configured posture for a single health check.
 *
 * - `automatic` — Mars acts on the finding without operator intervention:
 *   it enqueues the fix and reports afterwards.
 * - `manual` — the finding surfaces as a `health-check-alert` row in the
 *   action queue. The operator sees it and decides whether to trigger the
 *   fix. Nothing happens until they act.
 * - `off` — the check is silenced; no alerts or tasks are raised for it.
 *
 * The router (Steward) reads this value per check before deciding which of
 * the three routes to take for a given finding.
 */
const NO_DAEMON_MSG =
  'action queue: daemon not running — run `mars daemon start` (the action queue view is served by the daemon)'

/**
 * How long the CLI waits for the daemon to build and return the action-queue
 * view. Generous enough that a daemon under load never produces a false
 * "unknown" — the CLI must never claim the queue is empty when it is merely
 * slow. Exported so tests can build assertions against the configured value
 * rather than a hardcoded string.
 */
export const DAEMON_VIEW_TIMEOUT_MS = 30_000

const actionQueueViewErrorMessage = (
  err: unknown,
  elapsedMs: number,
  budgetMs: number,
): string => {
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  ) {
    return (
      `action queue: daemon did not answer within ${budgetMs / 1_000}s ` +
      `(${elapsedMs}ms elapsed; the view may be slow or the daemon busy)`
    )
  }
  if (err instanceof Error && /^daemon returned \d+$/.test(err.message)) {
    return `action queue: ${err.message}`
  }
  const errCode =
    typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
  const causeCode =
    typeof err === 'object' &&
    err !== null &&
    'cause' in err &&
    typeof err.cause === 'object' &&
    err.cause !== null &&
    'code' in err.cause
      ? err.cause.code
      : undefined
  const socketError = /\b(ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\b/
  if (
    socketError.test(errorMessage(err)) ||
    (typeof errCode === 'string' && socketError.test(errCode)) ||
    (typeof causeCode === 'string' && socketError.test(causeCode))
  ) {
    return NO_DAEMON_MSG
  }
  return `action queue: unable to read daemon view: ${errorMessage(err)}`
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Fetch the action queue view from the daemon's derived-view endpoint.
 * Throws when the daemon is unreachable or returns a non-2xx response.
 *
 * @param opts.kinds  When provided, only rows whose `kind` is in this set are
 *   returned. The set is forwarded as a `kinds` query param so the daemon can
 *   skip enrichment of non-matching rows — important for the polling pattern
 *   `--kind failed,stale-queued`.
 * @param opts.signal  Override the abort signal. Defaults to
 *   `AbortSignal.timeout(DAEMON_VIEW_TIMEOUT_MS)`. Pass a shorter timeout in
 *   tests to avoid 30-second waits.
 */
export const fetchActionQueueView = async (
  port: number,
  filter: string,
  opts?: { kinds?: ReadonlySet<string>; signal?: AbortSignal },
): Promise<ActionQueueGroupedRow[]> => {
  const url = new URL(`http://127.0.0.1:${port}/view/action-queue`)
  url.searchParams.set('filter', filter)
  if (opts?.kinds && opts.kinds.size > 0) {
    url.searchParams.set('kinds', [...opts.kinds].join(','))
  }
  const signal = opts?.signal ?? AbortSignal.timeout(DAEMON_VIEW_TIMEOUT_MS)
  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as ActionQueueGroupedRow[]
}

/**
 * Render the full detail header and body for an action-queue row.
 * Shared by `action-queue show` and the top-level `show` command's alert fallback
 * so both produce identical output.
 */
export const renderActionQueueDetail = (deps: CommandDeps, row: ActionQueueRow): void => {
  const classLabel = `[${(row.class ?? 'alert').toUpperCase()}]`
  const headline = row.humanSummary || row.title
  deps.out(`${classLabel}  ${headline}`)
  if (row.humanSummary && row.humanSummary !== row.title) {
    deps.out(`  title:     ${row.title}`)
  }
  deps.out(`id:        ${row.id}`)
  deps.out(`kind:      ${row.kind}`)
  if (row.kind !== 'verify-uncovered') deps.out(`entity:    ${row.entityId}`)
  deps.out(`priority:  ${row.priority}`)
  deps.out(`at:        ${row.at}`)
  deps.out(`dag:       ${JSON.stringify(row.dag)}`)
  deps.out('')
  deps.out(row.body)
  const detailEntries = Object.entries(row.humanDetail ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  )
  if (detailEntries.length > 0) {
    deps.out('')
    for (const [k, v] of detailEntries) {
      deps.out(`  ${k}: ${String(v)}`)
    }
  }
  if (row.kind === 'tool-promotion' && row.toolPromotionDetail) {
    const d = row.toolPromotionDetail
    deps.out('')
    deps.out(`helper:    ${d.helperKey}`)
    deps.out(`arcs:      ${d.motivatingArcIds.join(', ')}`)
    deps.out('')
    deps.out('benchmark:')
    deps.out(`  before   ${JSON.stringify(d.before)}`)
    deps.out(`  after    ${JSON.stringify(d.after)}`)
  }
  if (row.kind === 'health-check-alert' && row.conditionKey) {
    deps.out('')
    deps.out(`condition: ${row.conditionKey}`)
  }
}

const actionQueueList: Command = {
  path: 'action-queue list',
  summary: 'list action queue items [open|all] [--lean] [--kind <csv>] [--no-group]',
  usage: 'usage: mars action-queue list [open|all] [--lean] [--kind <csv>] [--no-group]',
  run: async (args, deps) => {
    const lean = hasFlag(args, '--lean')
    const noGroup = hasFlag(args, '--no-group')
    const rest = args.positional
    const filter = rest[0] ?? 'open'
    const allowed = new Set(['open', 'all'])
    if (!allowed.has(filter)) {
      deps.err('usage: mars action-queue list [open|all] [--lean] [--kind <csv>] [--no-group]')
      return { code: 2 }
    }
    const kindRaw = args.flags['--kind']
    const kindSet: Set<string> = kindRaw
      ? new Set(kindRaw.split(',').map((k) => k.trim()).filter(Boolean))
      : new Set()
    const unknownKind = [...kindSet].find((kind) => !isActionQueueKind(kind))
    if (unknownKind) {
      deps.err(`error: unknown action-queue kind '${unknownKind}'`)
      deps.err(`valid kinds: ${ACTION_QUEUE_KINDS.join(', ')}`)
      return { code: 2 }
    }
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let groupedRows: ActionQueueGroupedRow[]
    const fetchStartedAt = Date.now()
    try {
      // The endpoint applies groupActionQueueRows server-side (HR-3) so both
      // the CLI and the UI receive the same pre-grouped rows.
      groupedRows = await fetchActionQueueView(port, filter, {
        kinds: kindSet.size > 0 ? kindSet : undefined,
      })
    } catch (err) {
      const elapsedMs = Date.now() - fetchStartedAt
      deps.err(actionQueueViewErrorMessage(err, elapsedMs, DAEMON_VIEW_TIMEOUT_MS))
      return { code: 1 }
    }
    // Client-side kind filter: the daemon pre-filters by kinds when `--kind`
    // is set but a client-side pass guarantees correctness in case the daemon
    // returns a superset (e.g. a group spanning multiple kinds).
    if (kindSet.size > 0) {
      groupedRows = groupedRows.filter((gr) =>
        gr.type === 'group' ? kindSet.has(gr.kind) : kindSet.has(gr.row.kind),
      )
    } else if (filter === 'open') {
      // Draft proposals are a backlog, not operational alerts. Exclude them from
      // the default open listing so the count reflects rows that need an operator
      // decision. They remain accessible via --kind draft-proposal.
      groupedRows = groupedRows.filter((gr) =>
        gr.type === 'group' ? gr.kind !== 'draft-proposal' : gr.row.kind !== 'draft-proposal',
      )
    }
    if (groupedRows.length === 0) {
      // Machine-readable stdout stays empty on a clear queue — a poller that
      // diffs stdout lines must never see this as a row. The human-readable
      // confirmation goes to stderr so interactive operators still see it,
      // and it stays distinguishable from the daemon-down case (also
      // stderr, but exit 1 instead of exit 0).
      deps.err('action queue empty')
      return { code: 0 }
    }
    // --no-group: expand each server-side group back into individual item rows.
    // The endpoint always returns pre-grouped rows (HR-3); --no-group rebuilds
    // the flat view for pollers that must see exactly one line per raw row.
    const displayRows: ActionQueueGroupedRow[] = noGroup
      ? groupedRows.flatMap((gr) =>
          gr.type === 'group'
            ? gr.members.map((r) => ({ type: 'item' as const, row: r }))
            : [gr],
        )
      : groupedRows
    if (lean) {
      // Lean mode: count per kind, preview first LEAN_PREVIEW items.
      const counts: Record<string, number> = {}
      for (const dr of displayRows) {
        const kind = dr.type === 'group' ? dr.kind : dr.row.kind
        counts[kind] = (counts[kind] ?? 0) + 1
      }
      const parts = Object.entries(counts).map(([k, n]) => `${k}:${n}`)
      const totalVisible = displayRows.length
      deps.out(`action queue ${totalVisible} (${parts.join(', ')})`)
      for (const dr of displayRows.slice(0, LEAN_PREVIEW)) {
        if (dr.type === 'group') {
          deps.out(`  ${dr.id}  ${dr.count}× ${dr.causeLabel}`)
        } else {
          deps.out(`  ${dr.row.id}  ${dr.row.humanSummary || dr.row.title}`)
        }
      }
      const overflow = totalVisible - LEAN_PREVIEW
      if (overflow > 0) deps.out(`  ... +${overflow} more`)
    } else {
      // Full listing: one tab-separated line per visible row.
      for (const dr of displayRows) {
        if (dr.type === 'group') {
          deps.out(formatGroupRowTsv(dr))
        } else {
          const row = dr.row
          const classCol = `[${(row.class ?? 'alert').toUpperCase()}]`
          deps.out(`${row.id}\t${row.priority}\t${row.kind}\t${classCol}\t${row.humanSummary || row.title}`)
        }
      }
    }
    return { code: 0 }
  },
}

/**
 * The bare `action-queue` (no subcommand) is an alias for `action-queue list`
 * with the `open` filter — preserves `mars action-queue [--lean]`.
 */
const actionQueueDefault: Command = {
  path: 'action-queue',
  summary: 'list open action queue items (alias for `list open`)',
  usage: 'usage: mars action-queue [list [open|all]] [--lean] [--kind <csv>] | ...',
  run: (args, deps) => actionQueueList.run(args, deps),
}

const actionQueueShow: Command = {
  path: 'action-queue show',
  summary: 'show an action queue item',
  usage: 'usage: mars action-queue show <id>',
  run: async (args, deps) => {
    const id = args.positional.filter((a) => a !== '--lean')[0]
    if (!id) {
      deps.err('usage: mars action-queue show <id>')
      return { code: 2 }
    }
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    const showFetchStartedAt = Date.now()
    let allRows: ActionQueueRow[]
    try {
      const grouped = await fetchActionQueueView(port, 'all')
      // Flatten groups into individual rows for the show command (detail pane
      // operates at the individual-row level, not the group level).
      allRows = grouped.flatMap((gr) =>
        gr.type === 'group' ? gr.members : [gr.row],
      )
    } catch (err) {
      const elapsedMs = Date.now() - showFetchStartedAt
      deps.err(actionQueueViewErrorMessage(err, elapsedMs, DAEMON_VIEW_TIMEOUT_MS))
      return { code: 1 }
    }
    const row =
      allRows.find((r) => r.id === id || r.entityId === id) ??
      allRows.find((r) => r.id.startsWith(id) || r.entityId.startsWith(id))
    if (!row) {
      deps.err(`no action queue item matching ${id}`)
      return { code: 1 }
    }
    renderActionQueueDetail(deps, row)
    return { code: 0 }
  },
}

const actionQueueRaise: Command = {
  path: 'action-queue raise',
  summary: 'raise an action queue item from JSON (stdin or file)',
  usage: 'usage: mars action-queue raise --from <-|path>',
  run: async (args, deps) => {
    const from = args.flags['--from']
    if (!from) {
      deps.err('usage: mars action-queue raise --from <-|path>')
      return { code: 2 }
    }
    let raw: string
    try {
      raw = from === '-' ? await readStdin() : readFileSync(from, 'utf8')
    } catch (err) {
      deps.err(`failed to read input: ${errorMessage(err)}`)
      return { code: 2 }
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch (err) {
      deps.err(`invalid JSON: ${errorMessage(err)}`)
      return { code: 2 }
    }
    const parseResult = actionQueueRaiseSchema.safeParse(json)
    if (!parseResult.success) {
      deps.err('action-queue raise: schema validation failed')
      for (const issue of parseResult.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        deps.err(`  ${path}: ${issue.message}`)
      }
      return { code: 2 }
    }
    const data = parseResult.data
    const payload = {
      ...data,
      raisedBy: data.raisedBy === '' ? 'agent:cli' : data.raisedBy,
    }
    try {
      const id = await raiseActionQueueItem(payload)
      deps.out(id)
    } catch (err) {
      deps.err(`action-queue raise: ${errorMessage(err)}`)
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const actionQueueWatch: Command = {
  path: 'action-queue watch',
  summary: 'watch the action queue (interactive)',
  usage: 'usage: mars action-queue watch',
  run: async () => {
    const { runActionQueueWatch } = await import('../action-queue-watch')
    runActionQueueWatch()
    return { code: 0 }
  },
}

const actionQueueResolve: Command = {
  path: 'action-queue resolve',
  summary: 'manually resolve (close) an open action queue item',
  usage: 'usage: mars action-queue resolve <id> [--reason <text>]',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars action-queue resolve <id> [--reason <text>]')
      return { code: 2 }
    }
    const reason = args.flags['--reason'] ?? null
    const { migrateQueueSchema } = await import('../../core/queue')
    await migrateQueueSchema()
    const { getActionQueueItem, setActionQueueState } = await import('../../core/lib/action-queue')
    const item = await getActionQueueItem(id)
    if (item) {
      if (item.status === 'resolved') {
        deps.err(`item ${item.id} is already resolved`)
        return { code: 1 }
      }
      await setActionQueueState(item.id, 'resolved', {
        resolution: 'manual',
        note: typeof reason === 'string' ? reason : 'operator closed via CLI',
        by: 'operator:cli',
      })
      deps.out(`resolved ${item.id}`)
      return { code: 0 }
    }

    // Not found in DB — derived condition rows (e.g. daemon-died) have no DB
    // row. Fetch the live action-queue view from the daemon and handle the
    // handful of condition kinds that can be acknowledged via the CLI.
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port !== null) {
      let allRows: ActionQueueRow[]
      try {
        const grouped = await fetchActionQueueView(port, 'all', {
          signal: AbortSignal.timeout(10_000),
        })
        allRows = grouped.flatMap((gr) =>
          gr.type === 'group' ? gr.members : [gr.row],
        )
      } catch {
        allRows = []
      }
      const derivedRow =
        allRows.find((r) => r.id === id || r.entityId === id) ??
        allRows.find((r) => r.id.startsWith(id) || r.entityId.startsWith(id))
      if (derivedRow?.kind === 'daemon-died') {
        // Acknowledge daemon-died: call the daemon's dismiss-daemon-died endpoint
        // which deletes the crash marker file. The derived row disappears on the
        // next action-queue read.
        try {
          const res = await fetch(
            `http://127.0.0.1:${port}/actions/dismiss-daemon-died/${encodeURIComponent(derivedRow.entityId)}`,
            { method: 'POST', signal: AbortSignal.timeout(10_000) },
          )
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            deps.err(`failed to resolve daemon-died: daemon returned ${res.status}${text ? `: ${text}` : ''}`)
            return { code: 1 }
          }
        } catch (err) {
          deps.err(`failed to resolve daemon-died: ${errorMessage(err)}`)
          return { code: 1 }
        }
        deps.out(`resolved ${derivedRow.id}`)
        return { code: 0 }
      }
    }

    deps.err(`no action queue item matching ${id}`)
    return { code: 1 }
  },
}

const actionQueueReconcile: Command = {
  path: 'action-queue reconcile',
  summary: 'one-time pass: close every open action queue item for terminal tasks',
  usage: 'usage: mars action-queue reconcile',
  run: async (_args, deps) => {
    const { migrateQueueSchema } = await import('../../core/queue')
    await migrateQueueSchema()
    const { resolveStateClient } = await import('../../core/store/state-client')
    const { reconcileTerminalTasks } = await import(
      '../../core/daemon/lifecycle-reconcile'
    )
    const client = resolveStateClient()
    const { rowsResolved } = await reconcileTerminalTasks(client)
    if (rowsResolved === 0) {
      deps.out('nothing to reconcile — action queue is consistent')
    } else {
      deps.out(
        `closed ${rowsResolved} action queue item${rowsResolved === 1 ? '' : 's'}`,
      )
    }
    return { code: 0 }
  },
}

export const actionQueueCommands: readonly Command[] = [
  actionQueueList,
  actionQueueShow,
  actionQueueRaise,
  actionQueueWatch,
  actionQueueResolve,
  actionQueueReconcile,
  actionQueueDefault,
]
