/**
 * `action-queue` command group: `list` (default), `show`, `raise`
 * (JSON on stdin/file), `watch`, `reconcile`, and `resolve`.
 *
 * `list`, `show`, and the bare `action-queue` alias read through the daemon's
 * `GET /view/action-queue` endpoint so the CLI and UI always render the same
 * derived view (`buildActionQueueView`). If the daemon is not running, both
 * commands fail fast — there is no fallback to the raw DB path.
 *
 * `resolve` closes a single row by id or prefix — the precise operator gesture
 * that complements `reconcile`'s all-or-nothing sweep.
 *
 * --lean is a boolean flag that lands in positionals after routing.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  raiseActionQueueItem,
} from '../../core/lib/action-queue'
import { actionQueueRaiseSchema } from '../action-queue-raise-schema'
import type { Command } from '../command'
import { errorMessage } from './shared'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

const LEAN_PREVIEW = 3

const NO_DAEMON_MSG =
  'action queue: daemon not running — run `mars daemon start` (the action queue view is served by the daemon)'

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
  summary: 'list action queue items [open|all] [--lean]',
  usage: 'usage: mars action-queue list [open|all] [--lean]',
  run: async (args, deps) => {
    const lean = args.positional.includes('--lean')
    const rest = args.positional.filter((a) => a !== '--lean')
    const filter = rest[0] ?? 'open'
    const allowed = new Set(['open', 'all'])
    if (!allowed.has(filter)) {
      deps.err('usage: mars action-queue list [open|all] [--lean]')
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
  usage: 'usage: mars action-queue [list [open|all]] [--lean] | ...',
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
    deps.out(`title:     ${row.title}`)
    deps.out(`kind:      ${row.kind}`)
    deps.out(`entity:    ${row.entityId}`)
    deps.out(`priority:  ${row.priority}`)
    deps.out(`at:        ${row.at}`)
    deps.out(`dag:       ${JSON.stringify(row.dag)}`)
    deps.out('')
    deps.out(row.body)
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

const actionQueueResolve: Command = {
  path: 'action-queue resolve',
  summary: 'close a single action queue item by id or prefix',
  usage: 'usage: mars action-queue resolve <id> [--note <text>]',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars action-queue resolve <id> [--note <text>]')
      return { code: 1 }
    }
    const note = args.flags['--note']
    const { migrateQueueSchema } = await import('../../core/queue')
    await migrateQueueSchema()
    const { getActionQueueItem, setActionQueueState } = await import(
      '../../core/lib/action-queue'
    )
    const item = await getActionQueueItem(id)
    if (!item) {
      deps.err(`no action queue item matching ${id}`)
      return { code: 1 }
    }
    await setActionQueueState(item.id, 'resolved', {
      by: 'cli:operator',
      ...(note !== undefined ? { note } : {}),
    })
    deps.out(item.id)
    return { code: 0 }
  },
}

export const actionQueueCommands: readonly Command[] = [
  actionQueueList,
  actionQueueShow,
  actionQueueRaise,
  actionQueueWatch,
  actionQueueReconcile,
  actionQueueResolve,
  actionQueueDefault,
]
