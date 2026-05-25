/**
 * Derived inbox — the per-slice human-attention view.
 *
 * The inbox is NOT an event log. It is a *state view*: one row per real
 * thing that currently needs a human, computed on demand from the live
 * `tasks` / `proposals` tables and the worktrees on disk. A row appears
 * the moment its underlying entity enters a stuck state and disappears
 * the moment that entity leaves it — no ack/resolve bookkeeping required.
 *
 * Event history (every self-heal raise, recovery finding, status flip)
 * still lands in `inbox_items` / `inbox_history` via {@link ./inbox} —
 * that table is the audit trail, queried separately. The only persistent
 * operator opinion the derived view honours is a *dismissal*: "I have seen
 * this, hide it until the underlying state changes." Dismissals live in
 * `inbox_dismissals` and auto-expire when the entity's state moves on.
 *
 * Row sources (each yields at most one row per underlying entity):
 *   - failed task   — `tasks.status IN ('failed','dropped')`
 *   - blocked task  — `tasks.status = 'blocked'`
 *   - stale worktree — a `.mars/worktrees/<id>` dir on disk whose task is
 *                      terminal (done/dropped) or absent. A finished task
 *                      is supposed to clean up its own worktree, so the
 *                      mere existence of one is the anomaly.
 *   - draft proposal — `proposals.status = 'draft'`
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type Client } from '@libsql/client'
import { resolveContext } from '../context'
import { listProposals } from '../proposals'
import { listAllBlockers, listTasks, type Task, type TaskStatus } from '../queue'
import { openLibsql } from './libsql'
import {
  type DismissalEntityKind,
  isEntityDismissed,
  listDismissals,
} from './inbox-dismissals'

/** The four kinds of thing the derived inbox can surface. */
export type DerivedInboxKind =
  | 'failed-task'
  | 'blocked-task'
  | 'stale-worktree'
  | 'draft-proposal'

export type DerivedInboxPriority = 'high' | 'normal' | 'low'

/**
 * A node in the DAG context attached to a task-derived row. Just enough to
 * render the dependency neighbourhood without re-querying: id, current
 * status, and a one-line summary of the task's prompt.
 */
export interface DagNode {
  id: string
  status: TaskStatus
  summary: string
}

/**
 * Parent/child dependency neighbourhood for a task-derived inbox row.
 *
 * - `blockers`     — tasks this one waits on (outgoing `task_blockers` edges).
 * - `blocking`     — tasks waiting on this one (incoming edges).
 * - `origin`       — the origin task of a recovery chain, when `originId`
 *                    differs from the task's own id. Null otherwise.
 * - `descendants`  — recovery/fix tasks spawned from this one
 *                    (`fix_for_task_id` points back here).
 * - `proposalId`   — the parent proposal this slice came from, when set.
 */
export interface DagContext {
  blockers: DagNode[]
  blocking: DagNode[]
  origin: DagNode | null
  descendants: DagNode[]
  proposalId: string | null
}

/**
 * One derived inbox row. `id` is a stable composite of `kind:entityId` so
 * the CLI and UI can address a row without a separate primary key — the
 * row has no persisted identity of its own, it IS the entity's state.
 */
export interface DerivedInboxRow {
  /** Stable composite address, e.g. `failed-task:mars-abc12345`. */
  id: string
  kind: DerivedInboxKind
  /** The underlying entity id (task id, worktree id, or proposal id). */
  entityId: string
  priority: DerivedInboxPriority
  title: string
  /** Suggested next action(s) — operator-facing, multi-line. */
  body: string
  /** ISO timestamp that best represents "when this became relevant". */
  at: string
  /** Present for task-derived rows; null for worktree/proposal rows. */
  dag: DagContext | null
  /** True when the operator has resolved or dismissed this row (hidden from open). */
  dismissed: boolean
  /**
   * The specific operator action recorded:
   *   - `null`        — no operator action
   *   - `'ack'`       — acknowledged; still visible in the open filter
   *   - `'resolved'`  — resolved; hidden from the open filter
   *   - `'dismissed'` — dismissed; hidden from the open filter
   */
  ackState: 'ack' | 'resolved' | 'dismissed' | null
}

const DISMISSAL_KIND_BY_ROW: Record<DerivedInboxKind, DismissalEntityKind> = {
  'failed-task': 'task',
  'blocked-task': 'task',
  'stale-worktree': 'worktree',
  'draft-proposal': 'proposal',
}

let clientSingleton: Client | null = null

const getClient = (): Client => {
  if (clientSingleton) return clientSingleton
  const { stateDbPath } = resolveContext()
  clientSingleton = openLibsql({ url: `file:${stateDbPath}` })
  return clientSingleton
}

const summarize = (prompt: string, max = 80): string => {
  const oneLine = prompt.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['done', 'dropped'])

/**
 * Build the parent/child DAG neighbourhood for a task. Reuses the queue's
 * polymorphic blocker reader for the outgoing edges and a direct reverse
 * query for the incoming edges. `byId` is a prebuilt id→Task index so we
 * resolve neighbour summaries without N round-trips.
 */
const buildDag = async (
  task: Task,
  byId: Map<string, Task>,
): Promise<DagContext> => {
  const c = getClient()

  const toNode = (id: string): DagNode => {
    const t = byId.get(id)
    return {
      id,
      status: (t?.status ?? 'dropped') as TaskStatus,
      summary: t ? summarize(t.prompt) : '(unknown task)',
    }
  }

  const blockerRows = await listAllBlockers(task.id)
  const blockers = blockerRows
    .filter((b) => b.causeKind === 'task')
    .map((b) => toNode(b.causeId))

  const blockingResult = await c.execute({
    sql: `SELECT DISTINCT task_id FROM task_blockers WHERE blocker_task_id = ?`,
    args: [task.id],
  })
  const blocking = blockingResult.rows.map((row) =>
    toNode((row as unknown as { task_id: string }).task_id),
  )

  const descendantsResult = await c.execute({
    sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
    args: [task.id],
  })
  const descendants = descendantsResult.rows.map((row) =>
    toNode((row as unknown as { id: string }).id),
  )

  const origin =
    task.originId && task.originId !== task.id ? toNode(task.originId) : null

  return {
    blockers,
    blocking,
    origin,
    descendants,
    proposalId: null,
  }
}

const failedBody = (task: Task): string => {
  const reason = task.failureReason ?? task.error ?? 'unknown failure'
  return (
    `Task ${task.id} failed (phase: ${task.failedPhase ?? 'n/a'}).\n` +
    `Reason: ${reason}\n\n` +
    `Next actions:\n` +
    `  • Restart from scratch:  mars restart ${task.id}\n` +
    `  • Drop permanently:      mars purge ${task.id}`
  )
}

const blockedBody = (task: Task, dag: DagContext): string => {
  const waiting =
    dag.blockers.length > 0
      ? dag.blockers.map((b) => `  - ${b.id} (${b.status})`).join('\n')
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

/**
 * List the worktree directory names under `.mars/worktrees`. Tolerates a
 * missing directory (fresh repo) by returning an empty list.
 */
const listWorktreeDirs = async (repoRoot: string): Promise<string[]> => {
  const dir = join(repoRoot, '.mars', 'worktrees')
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export interface ListDerivedInboxOptions {
  /**
   * Which dismissal state to include:
   *   - `'open'` (default) — only rows the operator has NOT dismissed.
   *   - `'dismissed'`      — only dismissed rows.
   *   - `'all'`            — everything, each tagged with `dismissed`.
   */
  filter?: 'open' | 'dismissed' | 'all'
}

const PRIORITY_RANK: Record<DerivedInboxPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
}

/**
 * Compute the full derived inbox. Pure read: issues no writes. Tolerates a
 * fresh repo (missing tables / worktrees dir) by treating the absent source
 * as empty.
 */
export const listDerivedInbox = async (
  opts: ListDerivedInboxOptions = {},
): Promise<DerivedInboxRow[]> => {
  const filter = opts.filter ?? 'open'
  const { repoRoot } = resolveContext()

  const allTasks = await listTasks()
  const byId = new Map<string, Task>(allTasks.map((t) => [t.id, t]))
  const dismissals = await listDismissals()

  const noteToAckState = (note: string | null): 'ack' | 'resolved' | 'dismissed' => {
    if (note === 'ack') return 'ack'
    if (note === 'resolved') return 'resolved'
    return 'dismissed'
  }

  const dismissalNoteMap = new Map<string, string | null>(
    dismissals.map((d) => [`${d.entityKind}:${d.entityId}`, d.note]),
  )

  const getAckState = (key: string): 'ack' | 'resolved' | 'dismissed' | null => {
    if (!dismissalNoteMap.has(key)) return null
    return noteToAckState(dismissalNoteMap.get(key) ?? null)
  }

  const isDismissed = (key: string): boolean => {
    const s = getAckState(key)
    return s === 'resolved' || s === 'dismissed'
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
      priority = 'normal'
    }
    if (kind === null) continue

    const dag = await buildDag(task, byId)
    dag.proposalId = await proposalIdForTask(task)
    const body =
      kind === 'failed-task' ? failedBody(task) : blockedBody(task, dag)
    rows.push({
      id: `${kind}:${task.id}`,
      kind,
      entityId: task.id,
      priority,
      title:
        kind === 'failed-task'
          ? `Failed: ${summarize(task.prompt, 60)}`
          : `Blocked: ${summarize(task.prompt, 60)}`,
      body,
      at: task.updatedAt,
      dag,
      dismissed: isDismissed(`task:${task.id}`),
      ackState: getAckState(`task:${task.id}`),
    })
  }

  // --- stale worktrees (terminal-or-absent task with a worktree on disk) ---
  const worktreeDirs = await listWorktreeDirs(repoRoot)
  for (const name of worktreeDirs) {
    const task = byId.get(name)
    const isStale = task === undefined || TERMINAL_STATUSES.has(task.status)
    if (!isStale) continue
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
      dismissed: isDismissed(`worktree:${name}`),
      ackState: getAckState(`worktree:${name}`),
    })
  }

  // --- draft proposals ---
  const drafts = await listProposals({ status: 'draft' })
  for (const proposal of drafts) {
    rows.push({
      id: `draft-proposal:${proposal.id}`,
      kind: 'draft-proposal',
      entityId: proposal.id,
      priority: 'low',
      title: `Draft: ${summarize(proposal.title, 60)}`,
      body:
        `Draft proposal awaiting shaping.\n\n` +
        `Next actions:\n` +
        `  • Shape it:    /mars:grill ${proposal.id}\n` +
        `  • Promote it:  mars proposal promote ${proposal.id}\n` +
        `  • Reject it:   mars proposal reject ${proposal.id}`,
      at: new Date(proposal.updatedAt).toISOString(),
      dag: null,
      dismissed: isDismissed(`proposal:${proposal.id}`),
      ackState: getAckState(`proposal:${proposal.id}`),
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
    if (pr !== 0) return pr
    return b.at.localeCompare(a.at)
  })
  return filtered
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

/** Resolve the parent proposal id for a task, if it carries one. */
const proposalIdForTask = async (task: Task): Promise<string | null> => {
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT parent_proposal_id FROM tasks WHERE id = ?`,
    args: [task.id],
  })
  if (r.rows.length === 0) return null
  return (
    (r.rows[0] as unknown as { parent_proposal_id: string | null })
      .parent_proposal_id ?? null
  )
}

/**
 * Resolve a single derived row by its composite `kind:entityId` id, or by a
 * bare entity id (task id / worktree id / proposal id) when the kind prefix
 * is omitted. Returns null when nothing in the current state matches.
 */
export const getDerivedInboxRow = async (
  idOrEntity: string,
): Promise<DerivedInboxRow | null> => {
  const all = await listDerivedInbox({ filter: 'all' })
  const exact = all.find((r) => r.id === idOrEntity)
  if (exact) return exact
  const byEntity = all.filter((r) => r.entityId === idOrEntity)
  if (byEntity.length === 1) return byEntity[0]
  // Prefix match on entity id (e.g. an 8-hex prefix of a task id).
  if (idOrEntity.length >= 4) {
    const pref = all.filter((r) => r.entityId.startsWith(idOrEntity))
    if (pref.length === 1) return pref[0]
  }
  return null
}

export const dismissalKindForRow = (
  kind: DerivedInboxKind,
): DismissalEntityKind => DISMISSAL_KIND_BY_ROW[kind]

export { isEntityDismissed }
