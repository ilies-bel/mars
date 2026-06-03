/**
 * `action-queue` command group: `list` (default), `show`, `ack`, `resolve`,
 * `dismiss`, `undismiss`, `raise` (JSON on stdin/file), and `watch`.
 *
 * The action queue is the single human-facing work surface; these leaves read
 * and mutate it through the `core/lib/action-queue` modules. `--lean` is a
 * boolean flag that lands in positionals after routing.
 */

import { readFileSync } from 'node:fs'
import {
  raiseActionQueueItem,
  listActionQueueItems,
  getActionQueueItem,
  type ActionQueueItem,
} from '../../core/lib/action-queue'
import {
  dismissEntity,
  undismissEntity,
} from '../../core/lib/action-queue-dismissals'
import { resolveAuthor, formatAuthor } from '../../core/author'
import { actionQueueRaiseSchema } from '../action-queue-raise-schema'
import type { Command, CommandDeps } from '../command'
import { errorMessage } from './shared'

const LEAN_PREVIEW = 3

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

const printList = (deps: CommandDeps, items: ActionQueueItem[]): void => {
  if (items.length === 0) {
    deps.out('action queue empty')
    return
  }
  for (const item of items) {
    const flag =
      item.state === 'dismissed' || item.state === 'resolved'
        ? 'dismissed'
        : 'open'
    const priority = item.priority === 'urgent' ? 'high' : item.priority
    deps.out(`${item.id}\t${flag}\t${priority}\t${item.kind}\t${item.title}`)
  }
}

const printLean = (deps: CommandDeps, items: ActionQueueItem[]): void => {
  if (items.length === 0) {
    deps.out('action queue empty')
    return
  }
  const counts: Record<string, number> = {}
  for (const item of items) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1
  }
  const parts = Object.entries(counts).map(([k, n]) => `${k}:${n}`)
  deps.out(`action queue ${items.length} (${parts.join(', ')})`)
  for (const item of items.slice(0, LEAN_PREVIEW)) {
    deps.out(`  ${item.id}  ${item.title}`)
  }
  const overflow = items.length - LEAN_PREVIEW
  if (overflow > 0) deps.out(`  ... +${overflow} more`)
}

const printShow = (deps: CommandDeps, item: ActionQueueItem): void => {
  const entityId = extractEntityId(item)
  const dismissed = item.state === 'dismissed' || item.state === 'resolved'
  const priority = item.priority === 'urgent' ? 'high' : item.priority
  deps.out(`id:        ${item.id}`)
  deps.out(`kind:      ${item.kind}`)
  deps.out(`entity:    ${entityId}`)
  deps.out(`priority:  ${priority}`)
  deps.out(`dismissed: ${dismissed}`)
  deps.out(`at:        ${item.lastSeenAt ?? item.raisedAt}`)
  deps.out('')
  deps.out(item.body)
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
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
    const stateFilter =
      filter === 'dismissed'
        ? ('dismissed' as const)
        : filter === 'all'
          ? ('all' as const)
          : ('open' as const)
    const items = await listActionQueueItems(stateFilter)
    if (lean) printLean(deps, items)
    else printList(deps, items)
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
    const item = await getActionQueueItem(id)
    if (!item) {
      deps.err(`no action queue item matching ${id}`)
      return { code: 1 }
    }
    printShow(deps, item)
    return { code: 0 }
  },
}

const makeAckResolve = (verb: 'ack' | 'resolve'): Command => ({
  path: `action-queue ${verb}`,
  summary: `${verb} an action queue item (dismiss its entity)`,
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
    const entityKind = actionQueueKindToEntityKind(item.kind)
    const entityId = extractEntityId(item)
    const note = verb === 'ack' ? 'ack' : 'resolved'
    await dismissEntity(entityKind, entityId, { note })
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

export const actionQueueCommands: readonly Command[] = [
  actionQueueList,
  actionQueueShow,
  makeAckResolve('ack'),
  makeAckResolve('resolve'),
  actionQueueDismiss,
  actionQueueUndismiss,
  actionQueueRaise,
  actionQueueWatch,
  actionQueueDefault,
]
