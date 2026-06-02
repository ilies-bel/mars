/**
 * ActionQueue view builder — derives the ActionQueueRow[] the UI renders from raw
 * persisted actionQueue rows, task data, the error-kind registry, and the recipe
 * catalog. Moved here from ui/server/index.ts so the daemon is the sole reader
 * of its own database and the single authoritative source for every derived
 * actionQueue view.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_KILLED_SIGNATURE } from '../../lib/retry-budget'
import {
  lookupFailureKind,
  unknownFailureKind,
  failingStepFromSignature,
} from '../../lib/failure-kinds'

export type DerivedActionQueueKind = 'failed-task' | 'stale-worktree' | 'draft-proposal'
export type DerivedActionQueueFilter = 'open' | 'dismissed' | 'all'

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
  kind: DerivedActionQueueKind
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
   * Failure-reason catalog code (`tasks.failure_reason_code` / actionQueue-row
   * payload). Null on non-failed rows and on legacy rows landed before the
   * typed code was introduced.
   */
  failureReasonCode: string | null
}

/** Raw actionQueue row shape as persisted in `action_queue_items`. */
export interface PersistedActionQueueRow {
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

/** Narrow task shape `buildActionQueueView` needs — a subset of the queue Task. */
export interface TaskForActionQueue {
  id: string
  status: string
  prompt: string
  /** Full list of task ids that block this task (from task_blockers). */
  blockedBy: string[]
  /** The proposal this task was sliced from, or null. */
  parentProposalId: string | null
  failureSignature: string | null
  /**
   * First line of captured stderr/stdout from the failing step, used as the
   * `verboseReason` hint in `unknownFailureKind` when the signature is not
   * registered. Null on legacy tasks or when no output was captured.
   */
  lastErrorOutput?: string | null
  branch: string | null
  updatedAt: string
}

/** Narrow error-kind entry shape needed for action-menu assembly. */
interface ActionQueueErrorKind {
  kind: string
  recoveryActions: { id: string; label: string; op: string }[]
}

/**
 * State-store dependency: reads open actionQueue items and operator dismissals.
 * In the daemon this is backed by the in-process actionQueue / action-queue-dismissals
 * modules; in tests it can be stubbed.
 */
export interface ActionQueueStateStore {
  listOpenActionQueueItems(): Promise<PersistedActionQueueRow[]>
  /** Map key: `"<entityKind>:<entityId>"`. Value: note ('ack'|'resolved'|'dismissed'|null). */
  listActionQueueDismissals(): Promise<Map<string, string | null>>
}

/**
 * Task-store dependency: returns tasks with blocker and proposal info.
 * The daemon builds this from queue.ts + a task_blockers query.
 */
export interface ActionQueueTaskStore {
  listTasks(): Promise<TaskForActionQueue[]>
}

export interface BuildActionQueueViewParams {
  stateStore: ActionQueueStateStore
  taskStore: ActionQueueTaskStore
  /**
   * Error-kind registry map (key = error kind id). In the daemon this is
   * built from `listErrorKinds()` at request time. Used for stale-worktree
   * and draft-proposal row action assembly; failed-task rows derive actions
   * from the FailureKind registry instead.
   */
  errorKindRegistry: Map<string, ActionQueueErrorKind>
  /** Absolute path to the repo root — used for the stale-worktree git probe. */
  repoRoot: string
  filter: DerivedActionQueueFilter
}

/**
 * Derive the full ActionQueueRow[] view from injected stores.
 *
 * Behaviour mirrors ui/server/index.ts's `/api/action-queue/action-queue` handler
 * (lines 177–531 before this slice) exactly: same sort, same daemon-killed-
 * batch synthesis, same diagnose-failure gate, same stale-worktree git probe.
 */
export const buildActionQueueView = async ({
  stateStore,
  taskStore,
  errorKindRegistry,
  repoRoot,
  filter,
}: BuildActionQueueViewParams): Promise<ActionQueueRow[]> => {
  const persistedRows = await stateStore.listOpenActionQueueItems()
  const dismissalMap = await stateStore.listActionQueueDismissals()

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

  // Map a persisted ActionQueueKind to the ActionQueueRow `kind` vocabulary.
  const toUiKind = (k: string): DerivedActionQueueKind => {
    if (k === 'stale-worktree') return 'stale-worktree'
    if (k === 'draft-proposal') return 'draft-proposal'
    return 'failed-task'
  }

  // Map a UI kind to the dismissal entity kind.
  const toEntityKind = (
    uiKind: DerivedActionQueueKind,
  ): 'task' | 'worktree' | 'proposal' =>
    uiKind === 'stale-worktree'
      ? 'worktree'
      : uiKind === 'draft-proposal'
        ? 'proposal'
        : 'task'

  // Extract the entity id (task id, worktree id, or proposal id) from a row.
  const extractEntityId = (row: PersistedActionQueueRow): string => {
    if (row.kind === 'stale-worktree') {
      if (typeof row.context.taskId === 'string') return row.context.taskId
    }
    if (row.kind === 'draft-proposal') {
      if (typeof row.payload.proposalId === 'string') return row.payload.proposalId
    }
    // slices-dropped is keyed to a proposal, not a task — surface the proposal id
    // rather than falling back to the opaque row id.
    if (row.kind === 'slices-dropped') {
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

    // For failed-task rows, actions come from the FailureKind registry so
    // the title, reason, and action menu are always from the same record.
    // For stale-worktree and draft-proposal rows, the errorKindRegistry is
    // the authority (unchanged behaviour).
    let actions: { id: string; label: string; op: string }[]
    if (uiKind === 'failed-task') {
      const sig = taskById.get(entityId)?.failureSignature ?? null
      const fk =
        sig !== null
          ? (lookupFailureKind(sig) ??
            unknownFailureKind(sig.split('/')[0] ?? 'unknown', ''))
          : unknownFailureKind('unknown', '')
      actions = fk.actions as { id: string; label: string; op: string }[]
    } else {
      actions = (errorKindRegistry.get(errorKind)?.recoveryActions ?? []) as {
        id: string
        label: string
        op: string
      }[]
    }

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

    // Diagnosis persisted by the diagnose-failure agent onto the actionQueue payload.
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

    // For failed-task rows, derive title and body from the Failure kind registry
    // rather than from the persisted row strings — the registry provides warm,
    // human-readable copy keyed to the failure's actual cause.
    let title = row.title
    let body = row.body
    if (uiKind === 'failed-task') {
      const failedTask = taskById.get(entityId)
      const sig = failedTask?.failureSignature ?? null
      const fk =
        sig !== null
          ? (lookupFailureKind(sig) ??
              unknownFailureKind(
                failingStepFromSignature(sig),
                failedTask?.lastErrorOutput ?? '',
              ))
          : unknownFailureKind('unknown', failedTask?.lastErrorOutput ?? '')
      title = fk.warmTitle
      body = fk.verboseReason
    }

    rows.push({
      id: row.id,
      kind: uiKind,
      entityId,
      priority: toUiPriority(row.priority),
      title,
      body,
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
      lookupFailureKind(DAEMON_KILLED_SIGNATURE)?.actions ?? []
    ) as { id: string; label: string; op: string }[]
    const newest = daemonKilledVisible[0]!
    // Derive the batch row's title and body from the daemon-killed Failure kind
    // entry so the copy stays consistent with the registry rather than being
    // hardcoded here. The count is appended to the title for context.
    const daemonKilledKind = lookupFailureKind(DAEMON_KILLED_SIGNATURE)
    const batchTitle = daemonKilledKind
      ? `${daemonKilledKind.warmTitle} (${daemonKilledVisible.length})`
      : `Restart all daemon-killed tasks (${daemonKilledVisible.length})`
    const batchBody = daemonKilledKind
      ? daemonKilledKind.verboseReason
      : `${daemonKilledVisible.length} tasks were in flight when the daemon was killed.\n` +
        `None of these failures are task faults — a fresh dispatch is very likely to succeed.`
    filtered.unshift({
      id: 'failed-task:__daemon-killed-batch__',
      kind: 'failed-task',
      entityId: '__daemon-killed-batch__',
      priority: 'high',
      title: batchTitle,
      body: batchBody,
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
