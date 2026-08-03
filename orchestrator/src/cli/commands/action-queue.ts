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
import { raiseActionQueueItem } from '../../core/lib/action-queue'
import { ACTION_QUEUE_KINDS, isActionQueueKind } from '../../core/lib/action-queue-kinds'
import { actionQueueRaiseSchema } from '../action-queue-raise-schema'
import { hasFlag } from '../args'
import type { Command, CommandDeps } from '../command'
import { errorMessage, readDaemonPort } from './shared'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

const LEAN_PREVIEW = 3

const NO_DAEMON_MSG =
  'action queue: daemon not running — run `mars daemon start` (the action queue view is served by the daemon)'

const DAEMON_VIEW_TIMEOUT_MS = 2_000

const actionQueueViewErrorMessage = (err: unknown): string => {
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  ) {
    return `action queue: daemon did not answer within ${DAEMON_VIEW_TIMEOUT_MS / 1_000}s (the view may be slow or the daemon busy)`
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

// readDaemonPort is imported from ./shared and re-exported below for
// backwards compatibility with modules that import it from this file.
export { readDaemonPort }

/**
 * Fetch the action queue view from the daemon's derived-view endpoint.
 * Throws when the daemon is unreachable or returns a non-2xx response.
 */
export const fetchActionQueueView = async (
  port: number,
  filter: string,
): Promise<ActionQueueRow[]> => {
  const res = await fetch(
    `http://127.0.0.1:${port}/view/action-queue?filter=${encodeURIComponent(filter)}`,
    { signal: AbortSignal.timeout(DAEMON_VIEW_TIMEOUT_MS) },
  )
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as ActionQueueRow[]
}

/**
 * Render the full detail header and body for an action-queue row.
 * Shared by `action-queue show` and the top-level `show` command's alert fallback
 * so both produce identical output.
 */
export const renderActionQueueDetail = (deps: CommandDeps, row: ActionQueueRow): void => {
  deps.out(`id:        ${row.id}`)
  deps.out(`title:     ${row.title}`)
  deps.out(`kind:      ${row.kind}`)
  deps.out(`entity:    ${row.entityId}`)
  deps.out(`priority:  ${row.priority}`)
  deps.out(`at:        ${row.at}`)
  deps.out(`dag:       ${JSON.stringify(row.dag)}`)
  deps.out('')
  deps.out(row.body)
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
}

const actionQueueList: Command = {
  path: 'action-queue list',
  summary: 'list action queue items [open|all] [--lean] [--kind <csv>]',
  usage: 'usage: mars action-queue list [open|all] [--lean] [--kind <csv>]',
  run: async (args, deps) => {
    const lean = hasFlag(args, '--lean')
    const rest = args.positional
    const filter = rest[0] ?? 'open'
    const allowed = new Set(['open', 'all'])
    if (!allowed.has(filter)) {
      deps.err('usage: mars action-queue list [open|all] [--lean] [--kind <csv>]')
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
    let rows: ActionQueueRow[]
    try {
      rows = await fetchActionQueueView(port, filter)
    } catch (err) {
      deps.err(actionQueueViewErrorMessage(err))
      return { code: 1 }
    }
    if (kindSet.size > 0) {
      rows = rows.filter((row) => kindSet.has(row.kind))
    }
    if (rows.length === 0) {
      deps.out('action queue empty')
      return { code: 0 }
    }
    if (lean) {
      const counts: Record<string, number> = {}
      for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1
      const parts = Object.entries(counts).map(([k, n]) => `${k}:${n}`)
      deps.out(`action queue ${rows.length} (${parts.join(', ')})`)
      for (const row of rows.slice(0, LEAN_PREVIEW))
        deps.out(`  ${row.id}  ${row.title}`)
      const overflow = rows.length - LEAN_PREVIEW
      if (overflow > 0) deps.out(`  ... +${overflow} more`)
    } else {
      for (const row of rows) {
        deps.out(`${row.id}\t${row.priority}\t${row.kind}\t${row.title}`)
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
    let rows: ActionQueueRow[]
    try {
      rows = await fetchActionQueueView(port, 'all')
    } catch (err) {
      deps.err(actionQueueViewErrorMessage(err))
      return { code: 1 }
    }
    const row =
      rows.find((r) => r.id === id || r.entityId === id) ??
      rows.find((r) => r.id.startsWith(id) || r.entityId.startsWith(id))
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
  actionQueueReconcile,
  actionQueueDefault,
]
