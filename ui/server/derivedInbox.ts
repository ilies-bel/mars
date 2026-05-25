import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StateDb, Task, TaskDb, TaskStatus } from './db.ts'

/**
 * Derived inbox for the web UI — the read-only mirror of the orchestrator's
 * `lib/derived-inbox.ts`. The inbox is a per-slice STATE view, not an event
 * log: one row per thing that currently needs a human, computed on demand
 * from the live `tasks` / `proposals` tables and the worktrees on disk.
 *
 * Row sources (≤ 1 row per underlying entity):
 *   - failed task    — status in (failed, dropped)
 *   - blocked task   — status = blocked
 *   - stale worktree — a `.mars/worktrees/<id>` dir whose task is terminal
 *                      (done/dropped) or absent; a finished task should have
 *                      removed its own worktree.
 *   - draft proposal — proposals.status = draft
 *
 * Operator dismissals (the only persistent opinion) live in `inbox_dismissals`
 * and are read via `StateDb.listInboxDismissals()`.
 */

export type DerivedInboxKind =
  | 'failed-task'
  | 'blocked-task'
  | 'stale-worktree'
  | 'draft-proposal'

export type DerivedInboxPriority = 'high' | 'normal' | 'low'

export interface DagNode {
  id: string
  status: TaskStatus
  summary: string
}

export interface DagContext {
  blockers: DagNode[]
  blocking: DagNode[]
  descendants: DagNode[]
  proposalId: string | null
}

export interface DerivedInboxRow {
  id: string
  kind: DerivedInboxKind
  entityId: string
  priority: DerivedInboxPriority
  title: string
  body: string
  at: string
  dag: DagContext | null
  dismissed: boolean
}

const PRIORITY_RANK: Record<DerivedInboxPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['done', 'dropped'])

const summarize = (prompt: string, max = 80): string => {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

const listWorktreeDirs = async (repoRoot: string): Promise<string[]> => {
  const dir = join(repoRoot, '.mars', 'worktrees')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

const worktreeMtime = async (
  repoRoot: string,
  name: string,
): Promise<string> => {
  try {
    const s = await stat(join(repoRoot, '.mars', 'worktrees', name))
    return s.mtime.toISOString()
  } catch {
    return new Date(0).toISOString()
  }
}

const failedBody = (task: Task): string => {
  const reason = task.error ?? task.dropReason ?? 'unknown failure'
  return (
    `Task ${task.id} failed.\nReason: ${reason}\n\n` +
    `Next actions:\n` +
    `  • Restart from scratch:  mars restart ${task.id}\n` +
    `  • Drop permanently:      mars purge ${task.id}`
  )
}

const blockedBody = (task: Task, blockers: DagNode[]): string => {
  const waiting =
    blockers.length > 0
      ? blockers.map((b) => `  - ${b.id} (${b.status})`).join('\n')
      : '  (no live blockers — may be a phantom block)'
  return (
    `Task ${task.id} is blocked, waiting on:\n${waiting}\n\n` +
    `Next actions:\n` +
    `  • Remove one edge:    mars unblock ${task.id} <blocker-id>\n` +
    `  • Phantom-recover:    mars unblock ${task.id}`
  )
}

const staleWorktreeBody = (entityId: string, taskStatus: string): string =>
  `Worktree .mars/worktrees/${entityId} exists but its task is ${taskStatus}.\n` +
  `A finished task should have removed its own worktree, so this is leftover state.\n\n` +
  `Next actions:\n` +
  `  • Inspect:  git -C .mars/worktrees/${entityId} status\n` +
  `  • Remove:   git worktree remove --force .mars/worktrees/${entityId}`

export type DerivedInboxFilter = 'open' | 'dismissed' | 'all'

/**
 * Map a derived-inbox row kind to the dismissal entity kind it persists
 * under. Returns null for an unrecognised kind so callers can 400.
 */
export const dismissalKindForRow = (
  kind: DerivedInboxKind,
): 'task' | 'worktree' | 'proposal' | null => {
  switch (kind) {
    case 'failed-task':
    case 'blocked-task':
      return 'task'
    case 'stale-worktree':
      return 'worktree'
    case 'draft-proposal':
      return 'proposal'
    default:
      return null
  }
}

/**
 * Compute the full derived inbox. Pure read; tolerates fresh repos (missing
 * tables / worktrees dir) by treating the absent source as empty.
 */
export const listDerivedInbox = async (
  db: TaskDb,
  stateDb: StateDb,
  repoRoot: string,
  filter: DerivedInboxFilter = 'open',
): Promise<DerivedInboxRow[]> => {
  const tasksExist = await db.tableExists()
  const allTasks = tasksExist ? await db.listTasks() : []
  const byId = new Map<string, Task>(allTasks.map((t) => [t.id, t]))

  // Reverse blocker edges: blocker_task_id -> [task_id...].
  const blockingMap = new Map<string, string[]>()
  for (const t of allTasks) {
    for (const blockerId of t.blockedBy) {
      const arr = blockingMap.get(blockerId) ?? []
      arr.push(t.id)
      blockingMap.set(blockerId, arr)
    }
  }

  const dismissed = await stateDb.listInboxDismissals()
  const isDismissed = (kind: 'task' | 'worktree' | 'proposal', id: string) =>
    dismissed.has(`${kind}:${id}`)

  const toNode = (id: string): DagNode => {
    const t = byId.get(id)
    return {
      id,
      status: t?.status ?? 'dropped',
      summary: t ? summarize(t.prompt) : '(unknown task)',
    }
  }

  const rows: DerivedInboxRow[] = []

  // --- failed + blocked tasks ---
  for (const task of allTasks) {
    let kind: DerivedInboxKind | null = null
    let priority: DerivedInboxPriority = 'normal'
    if (task.status === 'failed' || task.status === 'dropped') {
      kind = 'failed-task'
      priority = 'high'
    } else if (task.status === 'blocked') {
      kind = 'blocked-task'
    }
    if (kind === null) continue

    const blockers = task.blockedBy.map(toNode)
    const blocking = (blockingMap.get(task.id) ?? []).map(toNode)
    const dag: DagContext = {
      blockers,
      blocking,
      descendants: [],
      proposalId: task.parentProposalId,
    }
    rows.push({
      id: `${kind}:${task.id}`,
      kind,
      entityId: task.id,
      priority,
      title:
        kind === 'failed-task'
          ? `Failed: ${summarize(task.prompt, 60)}`
          : `Blocked: ${summarize(task.prompt, 60)}`,
      body: kind === 'failed-task' ? failedBody(task) : blockedBody(task, blockers),
      at: task.updatedAt,
      dag,
      dismissed: isDismissed('task', task.id),
    })
  }

  // --- stale worktrees ---
  for (const name of await listWorktreeDirs(repoRoot)) {
    const task = byId.get(name)
    const stale = task === undefined || TERMINAL_STATUSES.has(task.status)
    if (!stale) continue
    const statusLabel = task ? task.status : 'absent (no matching task)'
    rows.push({
      id: `stale-worktree:${name}`,
      kind: 'stale-worktree',
      entityId: name,
      priority: 'low',
      title: `Stale worktree: ${name}`,
      body: staleWorktreeBody(name, statusLabel),
      at: await worktreeMtime(repoRoot, name),
      dag: null,
      dismissed: isDismissed('worktree', name),
    })
  }

  // --- draft proposals ---
  const proposalsExist = await stateDb.proposalsTableExists()
  const drafts = proposalsExist ? await stateDb.listDraftFeatures() : []
  for (const d of drafts) {
    rows.push({
      id: `draft-proposal:${d.id}`,
      kind: 'draft-proposal',
      entityId: d.id,
      priority: 'low',
      title: `Draft: ${summarize(d.goal || d.story, 60)}`,
      body:
        `Draft proposal awaiting shaping.\n\n` +
        `Next actions:\n` +
        `  • Shape it:    /mars:grill ${d.id}\n` +
        `  • Promote it:  mars proposal promote ${d.id}\n` +
        `  • Reject it:   mars proposal reject ${d.id}`,
      at: new Date(d.updatedAt).toISOString(),
      dag: null,
      dismissed: isDismissed('proposal', d.id),
    })
  }

  const filtered =
    filter === 'all'
      ? rows
      : filter === 'dismissed'
        ? rows.filter((r) => r.dismissed)
        : rows.filter((r) => !r.dismissed)

  filtered.sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    return pr !== 0 ? pr : b.at.localeCompare(a.at)
  })
  return filtered
}
