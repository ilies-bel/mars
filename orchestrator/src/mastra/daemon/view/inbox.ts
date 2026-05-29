/**
 * Inbox view builder — derives the ActionQueueRow[] the UI renders from raw
 * persisted inbox rows, task data, the error-kind registry, and the recipe
 * catalog. Moved here from ui/server/index.ts so the daemon is the sole reader
 * of its own database and the single authoritative source for every derived
 * inbox view.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_KILLED_SIGNATURE } from '../../lib/retry-budget'

export type DerivedInboxKind = 'failed-task' | 'stale-worktree' | 'draft-proposal'
export type DerivedInboxFilter = 'open' | 'dismissed' | 'all'

export interface StaleWorktreeDetail {
  prompt: string | null
  status: string
  ageHours: number
  updatedAt: string
  branch: string | null
  /** True when the worktree has no diff vs merge-base with main AND no untracked files. */
  empty: boolean
  investigation: string | null
}

export interface ActionQueueRow {
  id: string
  kind: DerivedInboxKind
  entityId: string
  priority: 'high' | 'normal' | 'low'
  title: string
  body: string
  at: string
  dag: {
    blockers: { id: string; status: string; summary: string }[]
    blocking: { id: string; status: string; summary: string }[]
    descendants: { id: string; status: string; summary: string }[]
    proposalId: string | null
  } | null
  dismissed: boolean
  ackState: 'ack' | 'resolved' | 'dismissed' | null
  errorKind: string
  actions: { id: string; label: string; op: string }[]
  staleWorktreeDetail: StaleWorktreeDetail | null
  diagnosis: { text: string; diagnosedAt: string } | null
  /**
   * Failure-reason catalog code (`tasks.failure_reason_code` / inbox-row
   * payload). Null on non-failed rows and on legacy rows landed before the
   * typed code was introduced.
   */
  failureReasonCode: string | null
}

/** Raw inbox row shape as persisted in `inbox_items`. */
export interface PersistedInboxRow {
  id: string
  kind: string
  priority: string
  title: string
  body: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  raisedAt: string
  lastSeenAt: string
}

/** Narrow task shape `buildInboxView` needs — a subset of the queue Task. */
export interface TaskForInbox {
  id: string
  status: string
  prompt: string
  /** Full list of task ids that block this task (from task_blockers). */
  blockedBy: string[]
  /** The proposal this task was sliced from, or null. */
  parentProposalId: string | null
  failureSignature: string | null
  branch: string | null
  updatedAt: string
}

/** Narrow error-kind entry shape needed for action-menu assembly. */
interface InboxErrorKind {
  kind: string
  recoveryActions: { id: string; label: string; op: string }[]
}

/**
 * State-store dependency: reads open inbox items and operator dismissals.
 * In the daemon this is backed by the in-process inbox / inbox-dismissals
 * modules; in tests it can be stubbed.
 */
export interface InboxStateStore {
  listOpenInboxItems(): Promise<PersistedInboxRow[]>
  /** Map key: `"<entityKind>:<entityId>"`. Value: note ('ack'|'resolved'|'dismissed'|null). */
  listInboxDismissals(): Promise<Map<string, string | null>>
}

/**
 * Task-store dependency: returns tasks with blocker and proposal info.
 * The daemon builds this from queue.ts + a task_blockers query.
 */
export interface InboxTaskStore {
  listTasks(): Promise<TaskForInbox[]>
}

/**
 * Recipe-catalog dependency used to gate the `diagnose-failure` action.
 * A signature that has a registered recovery recipe auto-recovers and does
 * not need a manual root-cause diagnosis.
 */
export interface InboxRecipeCatalog {
  has(sig: string): boolean
}

export interface BuildInboxViewParams {
  stateStore: InboxStateStore
  taskStore: InboxTaskStore
  /**
   * Error-kind registry map (key = error kind id). In the daemon this is
   * built from `listErrorKinds()` at request time.
   */
  errorKindRegistry: Map<string, InboxErrorKind>
  recipeCatalog: InboxRecipeCatalog
  /** Absolute path to the repo root — used for the stale-worktree git probe. */
  repoRoot: string
  filter: DerivedInboxFilter
}

/**
 * Derive the full ActionQueueRow[] view from injected stores.
 *
 * Behaviour mirrors ui/server/index.ts's `/api/inbox/action-queue` handler
 * (lines 177–531 before this slice) exactly: same sort, same daemon-killed-
 * batch synthesis, same diagnose-failure gate, same stale-worktree git probe.
 */
export const buildInboxView = async ({
  stateStore,
  taskStore,
  errorKindRegistry,
  recipeCatalog,
  repoRoot,
  filter,
}: BuildInboxViewParams): Promise<ActionQueueRow[]> => {
  const persistedRows = await stateStore.listOpenInboxItems()
  const dismissalMap = await stateStore.listInboxDismissals()

  const allTasks = await taskStore.listTasks()
  const taskById = new Map(allTasks.map((t) => [t.id, t]))
  const blockingMap = new Map<string, string[]>()
  for (const t of allTasks) {
    for (const blkId of t.blockedBy) {
      const arr = blockingMap.get(blkId) ?? []
      arr.push(t.id)
      blockingMap.set(blkId, arr)
    }
  }

  // Map a persisted InboxKind to the ActionQueueRow `kind` vocabulary.
  const toUiKind = (k: string): DerivedInboxKind => {
    if (k === 'stale-worktree') return 'stale-worktree'
    if (k === 'draft-proposal') return 'draft-proposal'
    return 'failed-task'
  }

  // Map a UI kind to the dismissal entity kind.
  const toEntityKind = (
    uiKind: DerivedInboxKind,
  ): 'task' | 'worktree' | 'proposal' =>
    uiKind === 'stale-worktree'
      ? 'worktree'
      : uiKind === 'draft-proposal'
        ? 'proposal'
        : 'task'

  // Extract the entity id (task id, worktree id, or proposal id) from a row.
  const extractEntityId = (row: PersistedInboxRow): string => {
    if (row.kind === 'stale-worktree') {
      if (typeof row.context.taskId === 'string') return row.context.taskId
    }
    if (row.kind === 'draft-proposal') {
      if (typeof row.payload.proposalId === 'string') return row.payload.proposalId
    }
    if (typeof row.payload.taskId === 'string') return row.payload.taskId
    if (typeof row.payload.originTaskId === 'string') return row.payload.originTaskId
    return row.id
  }

  const toUiPriority = (p: string): 'high' | 'normal' | 'low' => {
    if (p === 'urgent' || p === 'high') return 'high'
    if (p === 'low') return 'low'
    return 'normal'
  }

  // 'failed' maps to 'failed-task' for backwards compat with the action registry.
  const toErrorKind = (k: string): string =>
    k === 'failed' ? 'failed-task' : k

  const noteToAckState = (
    note: string | null,
  ): 'ack' | 'resolved' | 'dismissed' => {
    if (note === 'ack') return 'ack'
    if (note === 'resolved') return 'resolved'
    return 'dismissed'
  }

  const toNode = (id: string) => {
    const t = taskById.get(id)
    const summarize = (prompt: string): string => {
      const oneLine = prompt.replace(/\s+/g, ' ').trim()
      return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 79)}…`
    }
    return {
      id,
      status: (t?.status ?? 'dropped') as string,
      summary: t ? summarize(t.prompt) : '(unknown task)',
    }
  }

  const rows: ActionQueueRow[] = []

  for (const row of persistedRows) {
    const uiKind = toUiKind(row.kind)
    const entityId = extractEntityId(row)
    const entityKind = toEntityKind(uiKind)
    const dismissalKey = `${entityKind}:${entityId}`
    const ackState: 'ack' | 'resolved' | 'dismissed' | null =
      dismissalMap.has(dismissalKey)
        ? noteToAckState(dismissalMap.get(dismissalKey) ?? null)
        : null
    const dismissed = ackState === 'resolved' || ackState === 'dismissed'
    const errorKind = toErrorKind(row.kind)
    const allActions = (
      errorKindRegistry.get(errorKind)?.recoveryActions ?? []
    ) as { id: string; label: string; op: string }[]

    // Gate the Investigate (diagnose-failure) action to unknown-signature
    // failures only. A signature with a registered recipe auto-recovers, and
    // a daemon-killed task just needs a requeue — neither warrants a one-shot
    // root-cause diagnosis.
    const gatedTask = taskById.get(entityId)
    const sig = gatedTask?.failureSignature ?? null
    const diagnosable =
      uiKind === 'failed-task' &&
      sig !== null &&
      sig !== DAEMON_KILLED_SIGNATURE &&
      !recipeCatalog.has(sig)
    const actions = diagnosable
      ? allActions
      : allActions.filter((a) => a.op !== 'diagnose-failure')

    // DAG enrichment for task-backed rows.
    let dag: ActionQueueRow['dag'] = null
    if (uiKind === 'failed-task') {
      const task = taskById.get(entityId)
      if (task) {
        const blockers = task.blockedBy.map(toNode)
        const blocking = (blockingMap.get(entityId) ?? []).map(toNode)
        dag = {
          blockers,
          blocking,
          descendants: [],
          proposalId: task.parentProposalId,
        }
      }
    }

    // Stale-worktree enrichment: compute git-derived `empty` flag.
    // empty=true means no diff vs merge-base with main AND no untracked files.
    // Conservative default: false (e.g. when worktree path does not exist).
    let staleWorktreeDetail: StaleWorktreeDetail | null = null
    if (uiKind === 'stale-worktree') {
      const task = taskById.get(entityId)
      const worktreePath = join(repoRoot, '.mars', 'worktrees', entityId)
      let empty = false
      if (existsSync(worktreePath)) {
        try {
          const base = execFileSync(
            'git',
            ['-C', worktreePath, 'merge-base', 'HEAD', 'main'],
            { encoding: 'utf8' },
          ).trim()
          let hasDiff = false
          try {
            execFileSync(
              'git',
              ['-C', worktreePath, 'diff', '--quiet', `${base}..HEAD`],
              { encoding: 'utf8' },
            )
          } catch {
            hasDiff = true
          }
          const porcelain = hasDiff
            ? 'X'
            : execFileSync(
                'git',
                ['-C', worktreePath, 'status', '--porcelain'],
                { encoding: 'utf8' },
              ).trim()
          empty = !hasDiff && porcelain === ''
        } catch {
          // git unavailable or worktree not a git repo — conservative
          empty = false
        }
      }
      staleWorktreeDetail = {
        prompt:
          typeof row.payload.prompt === 'string'
            ? row.payload.prompt
            : (task?.prompt ?? null),
        status:
          task?.status ??
          (typeof row.payload.status === 'string'
            ? row.payload.status
            : 'absent (no matching task)'),
        ageHours:
          typeof row.payload.ageHours === 'number'
            ? row.payload.ageHours
            : 0,
        updatedAt:
          task?.updatedAt ??
          (typeof row.payload.updatedAt === 'string'
            ? row.payload.updatedAt
            : row.lastSeenAt),
        branch:
          typeof row.payload.branch === 'string'
            ? row.payload.branch
            : (task?.branch ?? null),
        empty,
        investigation:
          typeof row.payload.investigation === 'string'
            ? row.payload.investigation
            : null,
      }
    }

    // Diagnosis persisted by the diagnose-failure agent onto the inbox payload.
    let diagnosis: { text: string; diagnosedAt: string } | null = null
    const rawDiagnosis = row.payload.diagnosis
    if (
      rawDiagnosis !== null &&
      typeof rawDiagnosis === 'object' &&
      typeof (rawDiagnosis as { text?: unknown }).text === 'string' &&
      typeof (rawDiagnosis as { diagnosedAt?: unknown }).diagnosedAt === 'string'
    ) {
      diagnosis = {
        text: (rawDiagnosis as { text: string }).text,
        diagnosedAt: (rawDiagnosis as { diagnosedAt: string }).diagnosedAt,
      }
    }

    // Pull the failure-reason catalog code from the payload.
    const failureReasonCode =
      typeof row.payload.failureReasonCode === 'string'
        ? row.payload.failureReasonCode
        : null

    rows.push({
      id: row.id,
      kind: uiKind,
      entityId,
      priority: toUiPriority(row.priority),
      title: row.title,
      body: row.body,
      at: row.lastSeenAt,
      dag,
      dismissed,
      ackState,
      errorKind,
      actions,
      staleWorktreeDetail,
      diagnosis,
      failureReasonCode,
    })
  }

  const PRIORITY_RANK: Record<'high' | 'normal' | 'low', number> = {
    high: 0,
    normal: 1,
    low: 2,
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

  // When ≥2 daemon-killed rows are visible, prepend a synthetic batch-restart row.
  const daemonKilledVisible = filtered.filter(
    (r) => r.errorKind === 'daemon-killed',
  )
  if (daemonKilledVisible.length >= 2) {
    const batchActions = (
      errorKindRegistry.get('daemon-killed-batch')?.recoveryActions ?? []
    ) as { id: string; label: string; op: string }[]
    const newest = daemonKilledVisible[0]!
    filtered.unshift({
      id: 'failed-task:__daemon-killed-batch__',
      kind: 'failed-task',
      entityId: '__daemon-killed-batch__',
      priority: 'high',
      title: `Restart all daemon-killed tasks (${daemonKilledVisible.length})`,
      body:
        `${daemonKilledVisible.length} tasks were in flight when the daemon was killed.\n` +
        `None of these failures are task faults — a fresh dispatch is very likely to succeed.`,
      at: newest.at,
      dag: null,
      dismissed: false,
      ackState: null,
      errorKind: 'daemon-killed-batch',
      actions: batchActions,
      staleWorktreeDetail: null,
      diagnosis: null,
      failureReasonCode: null,
    })
  }

  return filtered
}
