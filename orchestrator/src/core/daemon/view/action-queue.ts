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
import { derivedRowActions } from '../../lib/derived-row-actions'

export type DerivedActionQueueKind = 'failed-task' | 'stale-worktree' | 'draft-proposal'
export type DerivedActionQueueFilter = 'open' | 'all'

/** Resolution metadata carried by resolved rows in history responses. */
export interface ActionQueueResolutionMeta {
  resolvedAt: string
  resolution: string | null
  resolutionNote: string | null
  rootCause: string | null
  resolvedBy: string | null
}

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
    edges: { from: string; to: string; kind: 'blocks' | 'recovers' }[]
  } | null
  errorKind: string
  actions: { id: string; label: string; op: string; needsConfirm?: boolean; hint?: string }[]
  staleWorktreeDetail: StaleWorktreeDetail | null
  diagnosis: { text: string; diagnosedAt: string } | null
  /**
   * Failure-reason catalog code (`tasks.failure_reason_code` / actionQueue-row
   * payload). Null on non-failed rows and on legacy rows landed before the
   * typed code was introduced.
   */
  failureReasonCode: string | null
  /**
   * When this row represents a fix/recovery task, the id of the origin task it
   * was spawned to fix. Null/absent for origin tasks or non-task rows.
   * Drives the "Fix for: <origin>" navigable link in the UI.
   */
  fixForTaskId?: string | null
  /**
   * Resolution metadata — non-null on history rows (state='resolved'), null on
   * live open rows. The UI uses this to determine whether to render the
   * Resolution header and suppress action buttons.
   */
  resolution?: ActionQueueResolutionMeta | null
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
  /** The item's dedup signature, used as the entity-id fallback. */
  signature?: string | null
  /** Resolution fields — populated on resolved rows, absent/null on open rows. */
  resolvedAt?: string | null
  resolution?: string | null
  resolutionNote?: string | null
  rootCause?: string | null
  resolvedBy?: string | null
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
  /**
   * When this task is a fix/recovery task, the id of the origin task it was
   * spawned to fix. Null for origin tasks. Drives arc-keyed DAG rendering:
   * origin rows carry the fix task in `dag.descendants`; fix rows carry this
   * id in `fixForTaskId` so the UI can link back.
   */
  fixForTaskId?: string | null
}

/**
 * State-store dependency: reads open actionQueue items.
 * In the daemon this is backed by the in-process actionQueue module;
 * in tests it can be stubbed.
 */
export interface ActionQueueStateStore {
  listOpenActionQueueItems(): Promise<PersistedActionQueueRow[]>
  /** Cursor-paged resolved rows, newest-first. Used by the history view. */
  listResolvedActionQueueItems(opts: {
    limit?: number
    cursor?: string | null
  }): Promise<{ items: PersistedActionQueueRow[]; nextCursor: string | null }>
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
  /** Absolute path to the repo root — used for the stale-worktree git probe. */
  repoRoot: string
  filter: DerivedActionQueueFilter
}

export interface BuildActionQueueHistoryViewParams {
  stateStore: ActionQueueStateStore
  taskStore: ActionQueueTaskStore
  /** Absolute path to the repo root — used for the stale-worktree git probe. */
  repoRoot: string
  limit?: number
  cursor?: string | null
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
  repoRoot,
  filter: _filter,
}: BuildActionQueueViewParams): Promise<ActionQueueRow[]> => {
  const persistedRows = await stateStore.listOpenActionQueueItems()

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

  // fixForTaskMap: origin task id → list of fix/recovery task ids that point at it.
  // Drives dag.descendants enrichment so each arc row shows its recovery chain.
  const fixForTaskMap = new Map<string, string[]>()
  for (const t of allTasks) {
    if (t.fixForTaskId) {
      const arr = fixForTaskMap.get(t.fixForTaskId) ?? []
      arr.push(t.id)
      fixForTaskMap.set(t.fixForTaskId, arr)
    }
  }

  // Map a persisted ActionQueueKind to the ActionQueueRow `kind` vocabulary.
  const toUiKind = (k: string): DerivedActionQueueKind => {
    if (k === 'stale-worktree') return 'stale-worktree'
    if (k === 'draft-proposal') return 'draft-proposal'
    return 'failed-task'
  }

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
    // Synthetic / non-task-keyed items (e.g. observability-store-oversize,
    // subscriber-stalled) carry a dedup signature but no task id in payload.
    return row.signature ?? row.id
  }

  const toUiPriority = (p: string): 'high' | 'normal' | 'low' => {
    if (p === 'urgent' || p === 'high') return 'high'
    if (p === 'low') return 'low'
    return 'normal'
  }

  // 'failed' maps to 'failed-task' for backwards compat with the action registry.
  const toErrorKind = (k: string): string =>
    k === 'failed' ? 'failed-task' : k

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
    const errorKind = toErrorKind(row.kind)

    // For failed-task rows, actions come from the FailureKind registry so
    // the title, reason, and action menu are always from the same record.
    // For stale-worktree, draft-proposal, and hitl-slice-needs-operator rows,
    // the non-failure derived-row action menu is the authority.
    let actions: { id: string; label: string; op: string }[]
    if (uiKind === 'failed-task' && row.kind !== 'hitl-slice-needs-operator') {
      const sig = taskById.get(entityId)?.failureSignature ?? null
      const fk =
        sig !== null
          ? (lookupFailureKind(sig) ??
            unknownFailureKind(failingStepFromSignature(sig), ''))
          : unknownFailureKind('unknown', '')
      actions = fk.actions as { id: string; label: string; op: string; needsConfirm?: boolean; hint?: string }[]
    } else {
      actions = derivedRowActions(errorKind, entityId) as {
        id: string
        label: string
        op: string
        needsConfirm?: boolean
        hint?: string
      }[]
    }

    // DAG enrichment for task-backed rows.
    let dag: ActionQueueRow['dag'] = null
    if (uiKind === 'failed-task' && row.kind !== 'hitl-slice-needs-operator') {
      const task = taskById.get(entityId)
      if (task) {
        const blockers = task.blockedBy.map(toNode)
        const blocking = (blockingMap.get(entityId) ?? []).map(toNode)
        // Enrich descendants with fix/recovery tasks that point at this origin.
        const descendants = (fixForTaskMap.get(entityId) ?? []).map(toNode)

        // Build the set of node ids present in this dag card.
        const dagNodeSet = new Set<string>([
          entityId,
          ...blockers.map((n) => n.id),
          ...blocking.map((n) => n.id),
          ...descendants.map((n) => n.id),
        ])

        // Collect candidate edges among dag nodes only.
        const rawEdges: { from: string; to: string; kind: 'blocks' | 'recovers' }[] = []

        // 'blocks' edges: for each node N, for each B in N.blockedBy that is also in the set.
        for (const nodeId of dagNodeSet) {
          for (const blockerId of (taskById.get(nodeId)?.blockedBy ?? [])) {
            if (dagNodeSet.has(blockerId)) {
              rawEdges.push({ from: blockerId, to: nodeId, kind: 'blocks' })
            }
          }
        }

        // 'recovers' edges: for each descendant D, emit D→entityId.
        for (const desc of descendants) {
          rawEdges.push({ from: desc.id, to: entityId, kind: 'recovers' })
        }

        // Deduplicate and sort deterministically (from, then to, then kind).
        const edgeKey = (e: { from: string; to: string; kind: string }) =>
          `${e.from}|${e.to}|${e.kind}`
        const seenEdges = new Set<string>()
        const edges = rawEdges
          .filter((e) => {
            const k = edgeKey(e)
            if (seenEdges.has(k)) return false
            seenEdges.add(k)
            return true
          })
          .sort((a, b) => {
            const ka = edgeKey(a)
            const kb = edgeKey(b)
            return ka < kb ? -1 : ka > kb ? 1 : 0
          })

        dag = {
          blockers,
          blocking,
          descendants,
          proposalId: task.parentProposalId,
          edges,
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
    // hitl-slice-needs-operator rows carry their own operator-facing title/body
    // set by the slicer; skip the failure-registry lookup so the persisted
    // copy (e.g. "HITL: End-to-end smoke against a real cluster") is shown
    // instead of the generic "A pipeline step did not complete" fallback.
    //
    // The discriminator is registration in the failure-kind registry
    // (lookupFailureKind returns non-null), NOT recipe presence. A kind like
    // daemon-killed is registered with a warmTitle but has recipe: null; it must
    // still render its warmTitle rather than "no recipe for <sig>".
    // Rows whose signature is NOT in the registry lead with "no recipe for <sig>"
    // so the operator immediately sees WHAT failed without digging into transcripts.
    let title = row.title
    let body = row.body
    if (uiKind === 'failed-task' && row.kind !== 'hitl-slice-needs-operator') {
      const failedTask = taskById.get(entityId)
      const sig = failedTask?.failureSignature ?? null
      if (sig !== null) {
        const fk = lookupFailureKind(sig)
        if (fk !== null) {
          // Registered signature — use the registry's warm title and verbose reason.
          title = fk.warmTitle
          body = fk.verboseReason
        } else {
          // Unregistered signature: lead with it so the operator immediately knows
          // what failed without digging into transcripts.
          title = `no recipe for ${sig}`
          body = unknownFailureKind(
            failingStepFromSignature(sig),
            failedTask?.lastErrorOutput ?? '',
          ).verboseReason
        }
      } else {
        const ufk = unknownFailureKind('unknown', failedTask?.lastErrorOutput ?? '')
        title = ufk.warmTitle
        body = ufk.verboseReason
      }
    }

    // Propagate fixForTaskId so the UI can render an "origin" link on recovery rows.
    // hitl-slice-needs-operator items are not task-backed, so no fixForTaskId.
    const fixForTaskId =
      uiKind === 'failed-task' && row.kind !== 'hitl-slice-needs-operator'
        ? (taskById.get(entityId)?.fixForTaskId ?? null)
        : null

    rows.push({
      id: row.id,
      kind: uiKind,
      entityId,
      priority: toUiPriority(row.priority),
      title,
      body,
      at: row.lastSeenAt,
      dag,
      errorKind,
      actions,
      staleWorktreeDetail,
      diagnosis,
      failureReasonCode,
      fixForTaskId,
    })
  }

  const PRIORITY_RANK: Record<'high' | 'normal' | 'low', number> = {
    high: 0,
    normal: 1,
    low: 2,
  }
  // Under the pure-projection model every row in persistedRows is already
  // open (the Invalidator is the sole row-closer). 'open' and 'all' therefore
  // return the same set; both are accepted for API compatibility.
  const filtered = rows.slice()

  filtered.sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    return pr !== 0 ? pr : b.at.localeCompare(a.at)
  })

  // When ≥2 daemon-killed rows are visible, prepend a synthetic batch-restart row.
  const daemonKilledVisible = filtered.filter(
    (r) => r.errorKind === 'daemon-killed',
  )
  if (daemonKilledVisible.length >= 2) {
    // The synthetic batch row surfaces only the batch verb from the
    // daemon-killed Failure kind record (the per-task requeue / restart-daemon
    // actions stay on the individual rows).
    const batchActions = (
      lookupFailureKind(DAEMON_KILLED_SIGNATURE)?.actions ?? []
    ).filter((a) => a.op === 'restart-all-daemon-killed') as {
      id: string
      label: string
      op: string
    }[]
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
      errorKind: 'daemon-killed-batch',
      actions: batchActions,
      staleWorktreeDetail: null,
      diagnosis: null,
      failureReasonCode: null,
    })
  }

  return filtered
}

/**
 * Derive an ActionQueueRow[] for resolved (history) rows, cursor-paged
 * newest-first by resolved_at.
 *
 * Applies the same kind-mapping, entity-id extraction, DAG enrichment, and
 * stale-worktree git probe as buildActionQueueView so the existing detail pane
 * can render resolved rows. Resolved rows carry resolution metadata and have
 * empty actions (they are read-only).
 */
export const buildActionQueueHistoryView = async ({
  stateStore,
  taskStore,
  repoRoot,
  limit,
  cursor,
}: BuildActionQueueHistoryViewParams): Promise<{
  rows: ActionQueueRow[]
  nextCursor: string | null
}> => {
  const { items: persistedRows, nextCursor } =
    await stateStore.listResolvedActionQueueItems({ limit, cursor })

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
  const fixForTaskMap = new Map<string, string[]>()
  for (const t of allTasks) {
    if (t.fixForTaskId) {
      const arr = fixForTaskMap.get(t.fixForTaskId) ?? []
      arr.push(t.id)
      fixForTaskMap.set(t.fixForTaskId, arr)
    }
  }

  const toUiKind = (k: string): DerivedActionQueueKind => {
    if (k === 'stale-worktree') return 'stale-worktree'
    if (k === 'draft-proposal') return 'draft-proposal'
    return 'failed-task'
  }

  const extractEntityId = (row: PersistedActionQueueRow): string => {
    if (row.kind === 'stale-worktree') {
      if (typeof row.context.taskId === 'string') return row.context.taskId
    }
    if (row.kind === 'draft-proposal') {
      if (typeof row.payload.proposalId === 'string') return row.payload.proposalId
    }
    if (row.kind === 'slices-dropped') {
      if (typeof row.payload.proposalId === 'string') return row.payload.proposalId
    }
    if (typeof row.payload.taskId === 'string') return row.payload.taskId
    if (typeof row.payload.originTaskId === 'string') return row.payload.originTaskId
    return row.signature ?? row.id
  }

  const toUiPriority = (p: string): 'high' | 'normal' | 'low' => {
    if (p === 'urgent' || p === 'high') return 'high'
    if (p === 'low') return 'low'
    return 'normal'
  }

  const toErrorKind = (k: string): string =>
    k === 'failed' ? 'failed-task' : k

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
    const errorKind = toErrorKind(row.kind)

    // DAG enrichment (same as live view).
    let dag: ActionQueueRow['dag'] = null
    if (uiKind === 'failed-task' && row.kind !== 'hitl-slice-needs-operator') {
      const task = taskById.get(entityId)
      if (task) {
        const blockers = task.blockedBy.map(toNode)
        const blocking = (blockingMap.get(entityId) ?? []).map(toNode)
        const descendants = (fixForTaskMap.get(entityId) ?? []).map(toNode)

        // Build the set of node ids present in this dag card.
        const dagNodeSet = new Set<string>([
          entityId,
          ...blockers.map((n) => n.id),
          ...blocking.map((n) => n.id),
          ...descendants.map((n) => n.id),
        ])

        // Collect candidate edges among dag nodes only.
        const rawEdges: { from: string; to: string; kind: 'blocks' | 'recovers' }[] = []

        // 'blocks' edges: for each node N, for each B in N.blockedBy that is also in the set.
        for (const nodeId of dagNodeSet) {
          for (const blockerId of (taskById.get(nodeId)?.blockedBy ?? [])) {
            if (dagNodeSet.has(blockerId)) {
              rawEdges.push({ from: blockerId, to: nodeId, kind: 'blocks' })
            }
          }
        }

        // 'recovers' edges: for each descendant D, emit D→entityId.
        for (const desc of descendants) {
          rawEdges.push({ from: desc.id, to: entityId, kind: 'recovers' })
        }

        // Deduplicate and sort deterministically (from, then to, then kind).
        const edgeKey = (e: { from: string; to: string; kind: string }) =>
          `${e.from}|${e.to}|${e.kind}`
        const seenEdges = new Set<string>()
        const edges = rawEdges
          .filter((e) => {
            const k = edgeKey(e)
            if (seenEdges.has(k)) return false
            seenEdges.add(k)
            return true
          })
          .sort((a, b) => {
            const ka = edgeKey(a)
            const kb = edgeKey(b)
            return ka < kb ? -1 : ka > kb ? 1 : 0
          })

        dag = { blockers, blocking, descendants, proposalId: task.parentProposalId, edges }
      }
    }

    // Stale-worktree enrichment (safe — catches missing dirs).
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
          typeof row.payload.ageHours === 'number' ? row.payload.ageHours : 0,
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

    // Diagnosis.
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

    const failureReasonCode =
      typeof row.payload.failureReasonCode === 'string'
        ? row.payload.failureReasonCode
        : null

    // Title / body from the failure-kind registry for failed-task rows.
    // Registered signatures use fk.warmTitle/fk.verboseReason; unregistered ones
    // lead with "no recipe for <sig>" (same rule as the live view).
    let title = row.title
    let body = row.body
    if (uiKind === 'failed-task' && row.kind !== 'hitl-slice-needs-operator') {
      const failedTask = taskById.get(entityId)
      const sig = failedTask?.failureSignature ?? null
      if (sig !== null) {
        const fk = lookupFailureKind(sig)
        if (fk !== null) {
          title = fk.warmTitle
          body = fk.verboseReason
        } else {
          title = `no recipe for ${sig}`
          body = unknownFailureKind(
            failingStepFromSignature(sig),
            failedTask?.lastErrorOutput ?? '',
          ).verboseReason
        }
      } else {
        const ufk = unknownFailureKind('unknown', failedTask?.lastErrorOutput ?? '')
        title = ufk.warmTitle
        body = ufk.verboseReason
      }
    }

    const fixForTaskId =
      uiKind === 'failed-task' && row.kind !== 'hitl-slice-needs-operator'
        ? (taskById.get(entityId)?.fixForTaskId ?? null)
        : null

    // Build resolution metadata from the resolved row fields.
    const resolution: ActionQueueResolutionMeta | null =
      row.resolvedAt
        ? {
            resolvedAt: row.resolvedAt,
            resolution: row.resolution ?? null,
            resolutionNote: row.resolutionNote ?? null,
            rootCause: row.rootCause ?? null,
            resolvedBy: row.resolvedBy ?? null,
          }
        : null

    rows.push({
      id: row.id,
      kind: uiKind,
      entityId,
      priority: toUiPriority(row.priority),
      title,
      body,
      at: row.lastSeenAt,
      dag,
      errorKind,
      actions: [], // Resolved rows are read-only; no actions.
      staleWorktreeDetail,
      diagnosis,
      failureReasonCode,
      fixForTaskId,
      resolution,
    })
  }

  return { rows, nextCursor }
}
