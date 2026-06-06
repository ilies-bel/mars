/**
 * `action-queue` command group: `list` (default), `show`, `ack`, `resolve`,
 * `dismiss`, `undismiss`, `raise` (JSON on stdin/file), and `watch`.
 *
 * `list`, `show`, and the bare `action-queue` alias read through the daemon's
 * `GET /view/action-queue` endpoint so the CLI and UI always render the same
 * derived view (`buildActionQueueView`). If the daemon is not running, both
 * commands fail fast — there is no fallback to the raw DB path.
 *
 * Mutation verbs (ack/resolve/dismiss/undismiss/raise/watch/reconcile) continue
 * to use the direct DB path unchanged.
 *
 * --lean is a boolean flag that lands in positionals after routing.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  raiseActionQueueItem,
  getActionQueueItem,
  setActionQueueState,
  type ActionQueueItem,
} from '../../core/lib/action-queue'
import {
  dismissEntity,
  undismissEntity,
} from '../../core/lib/action-queue-dismissals'
import { resolveAuthor, formatAuthor } from '../../core/author'
import { actionQueueRaiseSchema } from '../action-queue-raise-schema'
import type { Command } from '../command'
import { errorMessage } from './shared'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

const LEAN_PREVIEW = 3

const NO_DAEMON_MSG =
  'action queue: daemon not running — run `mars daemon start` (the action queue view is served by the daemon)'

const actionQueueKindToEntityKind = (
  kind: string,
): 'task' | 'worktree' | 'proposal' => {
  if (kind === 'stale-worktree') return 'worktree'
  if (kind === 'draft-proposal') return 'proposal'
  return 'task'
}

const extractEntityId = (item: ActionQueueItem): string => {
  if (item.kind === 'stale-worktree') {
    if (typeof item.context.taskId === 'string') return item.context.taskId
  }
  if (item.kind === 'draft-proposal') {
    if (typeof item.payload.proposalId === 'string')
      return item.payload.proposalId
  }
  if (typeof item.payload.taskId === 'string') return item.payload.taskId
  if (typeof item.payload.originTaskId === 'string')
    return item.payload.originTaskId
  return item.signature ?? item.id
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Read the daemon's HTTP port from the port file published by `listen(0)`.
 * Returns null when the file is absent or contains a non-integer value.
 */
const readDaemonPort = async (stateDir: string): Promise<number | null> => {
  try {
    const raw = (await readFile(join(stateDir, 'http.port'), 'utf8')).trim()
    const port = Number(raw)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/**
 * Fetch the action queue view from the daemon's derived-view endpoint.
 * Throws when the daemon is unreachable or returns a non-2xx response.
 */
const fetchActionQueueView = async (
  port: number,
  filter: string,
): Promise<ActionQueueRow[]> => {
  const res = await fetch(
    `http://127.0.0.1:${port}/view/action-queue?filter=${encodeURIComponent(filter)}`,
  )
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as ActionQueueRow[]
}

const actionQueueList: Command = {
  path: 'action-queue list',
  summary: 'list action queue items [open|dismissed|all] [--lean]',
  usage: 'usage: mars action-queue list [open|dismissed|all] [--lean]',
  run: async (args, deps) => {
    const lean = args.positional.includes('--lean')
    const rest = args.positional.filter((a) => a !== '--lean')
    const filter = rest[0] ?? 'open'
    const allowed = new Set(['open', 'dismissed', 'all'])
    if (!allowed.has(filter)) {
      deps.err('usage: mars action-queue list [open|dismissed|all] [--lean]')
      return { code: 1 }
    }
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let rows: ActionQueueRow[]
    try {
      rows = await fetchActionQueueView(port, filter)
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
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
        const flag = row.dismissed ? 'dismissed' : 'open'
        deps.out(`${row.id}\t${flag}\t${row.priority}\t${row.kind}\t${row.title}`)
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
  usage: 'usage: mars action-queue [list [open|dismissed|all]] [--lean] | ...',
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
      return { code: 1 }
    }
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let rows: ActionQueueRow[]
    try {
      rows = await fetchActionQueueView(port, 'all')
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    const row =
      rows.find((r) => r.id === id || r.entityId === id) ??
      rows.find((r) => r.id.startsWith(id) || r.entityId.startsWith(id))
    if (!row) {
      deps.err(`no action queue item matching ${id}`)
      return { code: 1 }
    }
    deps.out(`id:        ${row.id}`)
    deps.out(`kind:      ${row.kind}`)
    deps.out(`entity:    ${row.entityId}`)
    deps.out(`priority:  ${row.priority}`)
    deps.out(`dismissed: ${row.dismissed}`)
    deps.out(`at:        ${row.at}`)
    deps.out(`dag:       ${JSON.stringify(row.dag)}`)
    deps.out('')
    deps.out(row.body)
    return { code: 0 }
  },
}

const makeAckResolve = (verb: 'ack' | 'resolve'): Command => ({
  path: `action-queue ${verb}`,
  summary: `${verb} an action queue item`,
  usage: `usage: mars action-queue ${verb} <id>`,
  run: async (args, deps) => {
    const id = args.positional.filter((a) => a !== '--lean')[0]
    if (!id) {
      deps.err(`usage: mars action-queue ${verb} <id>`)
      return { code: 1 }
    }
    const item = await getActionQueueItem(id)
    if (!item) {
      deps.err(`no action queue item matching ${id}`)
      return { code: 1 }
    }
    if (verb === 'resolve') {
      // Hard-close the action_queue_items row so state/resolved_at/resolution
      // are persisted. dismissEntity only wrote to action_queue_dismissals and
      // left the row state = 'open' — a silent no-op for task.dropped rows that
      // have no eviction event to close them automatically.
      await setActionQueueState(item.id, 'resolved', { note: 'operator-resolved' })
    } else {
      const entityKind = actionQueueKindToEntityKind(item.kind)
      const entityId = extractEntityId(item)
      await dismissEntity(entityKind, entityId, { note: 'ack' })
    }
    deps.out(`${verb} ${item.id}`)
    return { code: 0 }
  },
})

const actionQueueDismiss: Command = {
  path: 'action-queue dismiss',
  summary: 'dismiss an action queue item',
  usage: 'usage: mars action-queue dismiss <id> [--note <text>]',
  run: async (args, deps) => {
    const id = args.positional.filter((a) => a !== '--lean')[0]
    if (!id) {
      deps.err('usage: mars action-queue dismiss <id>')
      return { code: 1 }
    }
    const item = await getActionQueueItem(id)
    if (!item) {
      deps.err(`no action queue item matching ${id}`)
      return { code: 1 }
    }
    const entityKind = actionQueueKindToEntityKind(item.kind)
    const entityId = extractEntityId(item)
    const by = formatAuthor(resolveAuthor(args.flags['--author']))
    const note = args.flags['--note']
    await dismissEntity(entityKind, entityId, {
      by,
      ...(note !== undefined ? { note } : {}),
    })
    deps.out(`dismiss ${item.id}`)
    return { code: 0 }
  },
}

const actionQueueUndismiss: Command = {
  path: 'action-queue undismiss',
  summary: 'undismiss an action queue item',
  usage: 'usage: mars action-queue undismiss <id>',
  run: async (args, deps) => {
    const id = args.positional.filter((a) => a !== '--lean')[0]
    if (!id) {
      deps.err('usage: mars action-queue undismiss <id>')
      return { code: 1 }
    }
    const item = await getActionQueueItem(id)
    if (!item) {
      deps.err(`no action queue item matching ${id}`)
      return { code: 1 }
    }
    const entityKind = actionQueueKindToEntityKind(item.kind)
    const entityId = extractEntityId(item)
    const removed = await undismissEntity(entityKind, entityId)
    deps.out(removed ? `undismiss ${item.id}` : `${item.id} was not dismissed`)
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
    const { rowsResolved, dismissalsCleared } =
      await reconcileTerminalTasks(client)
    if (rowsResolved === 0 && dismissalsCleared === 0) {
      deps.out('nothing to reconcile — action queue is consistent')
    } else {
      if (rowsResolved > 0)
        deps.out(
          `closed ${rowsResolved} action queue item${rowsResolved === 1 ? '' : 's'}`,
        )
      if (dismissalsCleared > 0)
        deps.out(
          `cleared ${dismissalsCleared} orphaned dismissal${dismissalsCleared === 1 ? '' : 's'}`,
        )
    }
    return { code: 0 }
  },
}

export const actionQueueCommands: readonly Command[] = [
  actionQueueList,
  actionQueueShow,
  makeAckResolve('ack'),
  makeAckResolve('resolve'),
  actionQueueDismiss,
  actionQueueUndismiss,
  actionQueueRaise,
  actionQueueWatch,
  actionQueueReconcile,
  actionQueueDefault,
]
