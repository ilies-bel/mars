/**
 * queue-primitives.ts — dependency-free leaf holding pure types, validators,
 * row mappers, and `getTask` (ADR-0101).
 *
 * This module must NOT value-import from `queue.ts`, `arc.ts`, or
 * `store/task-store.ts`. Type-only imports from those are fine because
 * `no-circular` is configured with `viaOnly: { dependencyTypesNot:
 * ['type-only'] }`, so a cycle containing a type-only edge is not reported.
 *
 * `queue.ts` re-exports every public symbol here for backward compatibility
 * with its ~200 existing importers. New call sites inside `core/arc*` must
 * import from this leaf directly.
 */

import { parseClaudeSessionIds } from './claude-session-ids'
import { ensureQueueSchema, resolveQueueClient } from './queue-client'
import type { DbStatement, DbResultSet } from './db'
import type { Author, AuthorKind } from '../author'
import type { SliceSpec, SubDeliverableSpec } from '../slice-spec'
// Type-only, deliberately: see the module header. A value-import of either of
// these would close a runtime cycle; as `import type` they are erased at
// compile time and `no-circular`'s `viaOnly: { dependencyTypesNot:
// ['type-only'] }` does not report the edge.
import type { ReviewPacket } from './review-packet'
import type { DomainTaskStore as TaskStore } from '../store/task-store'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'draft'
  | 'triaging'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'awaiting-validation'
  | 'awaiting-human'
  | 'merging'
  | 'vega-reconciling'
  | 'done'
  | 'failed'
  | 'dropped'
  | 'blocked'
  | 'under_investigation'

export type TaskDropReason =
  | 'origin-succeeded'
  | 'superseded'
  | 'arc-rescued'
  | 'purged'
  | 'slicer-rollback'
  | 'reslice'
  | 'slicer-preflight'

export type TaskKind = 'task' | 'fix' | 'diagnose'

export type TaskTag = string

export const TASK_TAGS: readonly string[] = ['coder'] as const

export type FailedPhase = 'setup' | 'code' | 'verify' | 'merge'

export type MergeMode = 'auto' | 'gated'

export const MERGE_MODES: readonly MergeMode[] = ['auto', 'gated'] as const

export interface TaskSpec {
  files: readonly string[]
  verifyCmd: string | null
  doneCriteria: readonly string[]
  mergeMode: MergeMode
  readFirst?: readonly string[]
  prescriptiveAction?: string | null
  sliceKind?: 'coder' | 'hitl'
  subDeliverable?: SubDeliverableSpec
  executionMode?: 'coordinated'
  slicePlan?: SliceSpec[]
  previewCmd?: string | null
}

export const EMPTY_TASK_SPEC: TaskSpec = {
  files: [],
  verifyCmd: null,
  doneCriteria: [],
  mergeMode: 'auto',
}

export interface TaskPlan {
  functional: string
  technical: string
}

export interface QaReportCriterion {
  criterion: string
  verdict: 'pass' | 'fail' | 'unverifiable'
  screenshotPath: string | null
  note: string
}

export interface QaReport {
  criteria: QaReportCriterion[]
  bootReason: string | null
  completedAt: string
  durationMs: number | null
}

export interface Task {
  id: string
  prompt: string
  status: TaskStatus
  plan: TaskPlan | null
  branch: string | null
  worktreePath: string | null
  claudeSessionId: string | null
  claudeSessionIds: string[]
  error: string | null
  author: Author | null
  dropReason: TaskDropReason | null
  failureReason: string | null
  failureReasonCode: string | null
  stallDiagnostics: string | null
  recoverySpawnedCount: number
  envRestartCount: number
  fixForTaskId: string | null
  failureSignature: string | null
  kind?: TaskKind
  tags: TaskTag[]
  originId: string
  priority: number
  failedPhase: FailedPhase | null
  spec: TaskSpec | null
  integrationHeadSha: string | null
  devServerUrl: string | null
  devServerPid: number | null
  previewValidated: boolean
  recoveryPayload: string | null
  intent: string
  leaseOwner: string | null
  leasedAt: string | null
  leaseNote: string | null
  originSessionId: string | null
  workflow: string | null
  qa: 'auto' | 'manual'
  currentStepName: string | null
  currentStepGuide: string | null
  activityDetail?: string | null
  compensatesArcId?: string | null
  requeueAnchorMs?: number | null
  requeueDispatchUptimeMs?: number | null
  quotaRejectedAttempts?: number
  envApiUnreachableAttempts?: number
  qaReport?: QaReport | null
  deferrable: boolean
  createdAt: string
  updatedAt: string
}

export interface EnqueueTaskOptions {
  skipTriage?: boolean
  chatThreadId?: string
  author?: Author
  originId?: string
  priority?: number
  parentProposalId?: string
  sliceIndex?: number
  tags?: TaskTag[]
  kind?: TaskKind
  spec?: TaskSpec
  intent?: string
  originSessionId?: string | null
  workflow?: string | null
  qa?: 'auto' | 'manual'
  deferrable?: boolean
  compensatesArcId?: string
  followupDedupKey?: string
  findingKey?: string
  supersedes?: string
}

export interface DropTaskResult {
  taskId: string
  previousStatus: TaskStatus
  edgesRemoved: { incoming: number; outgoing: number }
  cascadedFixTaskIds: string[]
  mergeJobsDeleted: number
  originsReparented: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'failed',
  'dropped',
])

export const UNSETTLED_BLOCKER_SQL = `t.status NOT IN ('done', 'dropped')`

export const MIN_PRIORITY = 0
export const MAX_PRIORITY = 3

// ---------------------------------------------------------------------------
// Validators / helpers
// ---------------------------------------------------------------------------

export const isTaskTag = (value: unknown): value is TaskTag =>
  typeof value === 'string' && value.length > 0

export const isMergeMode = (value: unknown): value is MergeMode =>
  value === 'auto' || value === 'gated'

export const validatePriority = (value: number): void => {
  if (!Number.isInteger(value) || value < MIN_PRIORITY || value > MAX_PRIORITY) {
    throw new Error(
      `priority must be an integer in ${MIN_PRIORITY}..${MAX_PRIORITY}; got ${value}`,
    )
  }
}

export const deriveTaskKind = (fixForTaskId: string | null): TaskKind =>
  fixForTaskId === null ? 'task' : 'fix'

export const assertTaskKindInvariant = (
  kind: TaskKind,
  fixForTaskId: string | null,
): void => {
  if (kind === 'fix' && fixForTaskId === null) {
    throw new Error(
      `task kind 'fix' requires a non-null fix-for pointer; got null`,
    )
  }
  if (kind === 'task' && fixForTaskId !== null) {
    throw new Error(
      `task kind 'task' requires a null fix-for pointer; got ${fixForTaskId}`,
    )
  }
  if (kind === 'diagnose' && fixForTaskId !== null) {
    throw new Error(
      `task kind 'diagnose' requires a null fix-for pointer; got ${fixForTaskId}`,
    )
  }
}

export const coerceToString = (value: unknown, label: string): string => {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder('utf-8').decode(value)
  if (value instanceof ArrayBuffer) {
    return new TextDecoder('utf-8').decode(new Uint8Array(value))
  }
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  throw new TypeError(
    `${label} must be a string; got ${value === null ? 'null' : typeof value}`,
  )
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly fromStatus: string,
    public readonly toStatus: string,
  ) {
    super(
      `Illegal task status transition: task ${taskId} is in terminal status '${fromStatus}' and cannot transition to '${toStatus}'`,
    )
    this.name = 'IllegalTransitionError'
  }
}

// ---------------------------------------------------------------------------
// SQL / row mapping
// ---------------------------------------------------------------------------

export const TASK_SEL = `
SELECT
  t.id, t.prompt, t.status, t.plan_functional, t.plan_technical,
  t.branch, t.worktree_path, t.claude_session_id,
  (SELECT COALESCE(json_agg(session_id ORDER BY position)::text, '[]')
     FROM task_claude_sessions WHERE task_id = t.id) AS claude_session_ids,
  t.error, t.drop_reason, t.recovery_spawned_count, t.env_restart_count,
  t.author_kind, t.author_name,
  t.failure_reason, t.failure_reason_code, t.stall_diagnostics, t.recovery_payload,
  t.fix_for_task_id, t.failure_signature, t.kind, t.priority, t.tag,
  t.tags_json, t.origin_id, t.parent_proposal_id, t.slice_index,
  t.failed_phase, t.resume_from,
  (SELECT COALESCE(json_agg(path ORDER BY position)::text, '[]')
     FROM task_spec_files WHERE task_id = t.id) AS files_json,
  t.verify_cmd,
  (SELECT COALESCE(json_agg(criterion ORDER BY position)::text, '[]')
     FROM task_done_criteria WHERE task_id = t.id) AS done_criteria_json,
  t.merge_mode, t.read_first_json, t.prescriptive_action, t.slice_kind,
  t.sub_deliverable_json, t.integration_head_sha,
  t.dev_server_url, t.dev_server_pid, t.preview_validated, t.intent,
  t.lease_owner, t.leased_at, t.lease_note,
  t.origin_session_id, t.workflow,
  t.current_step_name, t.current_step_guide,
  t.activity_detail,
  t.compensates_arc_id,
  t.qa,
  t.requeue_anchor_ms,
  t.requeue_dispatch_uptime_ms,
  t.qa_report_json,
  t.deferrable,
  t.quota_rejected_attempts,
  t.env_api_unreachable_attempts,
  t.created_at, t.updated_at
FROM tasks t`

export const ORDINARY_TASK_SQL = `COALESCE(t.kind, 'task') <> 'structured-write'`

// ---------------------------------------------------------------------------
// Private helpers for rowToTask
// ---------------------------------------------------------------------------

const parseStringArray = (raw: unknown): string[] => {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

const parseQaReport = (raw: unknown): QaReport | null => {
  if (raw === null || raw === undefined) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || !Array.isArray(parsed.criteria)) return null
    return parsed as QaReport
  } catch {
    return null
  }
}

const coerceFailedPhase = (raw: unknown): FailedPhase | null => {
  if (raw === 'setup' || raw === 'code' || raw === 'verify' || raw === 'merge') return raw
  return null
}

const rowToTaskSpec = (row: Record<string, unknown>): TaskSpec | null => {
  const rawFiles = (row.files_json as string | null) ?? null
  const rawVerify = (row.verify_cmd as string | null) ?? null
  const rawDone = (row.done_criteria_json as string | null) ?? null
  const rawType = (row.merge_mode as string | null) ?? null
  const rawReadFirst = (row.read_first_json as string | null) ?? null
  const rawPrescriptive = (row.prescriptive_action as string | null) ?? null
  const rawSliceKind = (row.slice_kind as string | null) ?? null
  const rawSubDeliverable = (row.sub_deliverable_json as string | null) ?? null
  const anySet =
    rawFiles !== null ||
    rawVerify !== null ||
    rawDone !== null ||
    rawType !== null ||
    rawReadFirst !== null ||
    rawPrescriptive !== null ||
    rawSliceKind !== null ||
    rawSubDeliverable !== null
  if (!anySet) return null
  let subDeliverable: SubDeliverableSpec | undefined
  if (rawSubDeliverable) {
    try {
      subDeliverable = JSON.parse(rawSubDeliverable) as SubDeliverableSpec
    } catch {
      subDeliverable = undefined
    }
  }
  return {
    files: parseStringArray(rawFiles),
    verifyCmd: rawVerify,
    doneCriteria: parseStringArray(rawDone),
    mergeMode: isMergeMode(rawType) ? rawType : 'auto',
    readFirst: parseStringArray(rawReadFirst),
    prescriptiveAction: rawPrescriptive,
    sliceKind:
      rawSliceKind === 'coder' || rawSliceKind === 'hitl'
        ? rawSliceKind
        : undefined,
    subDeliverable,
  }
}

// ---------------------------------------------------------------------------
// rowToTask
// ---------------------------------------------------------------------------

export const rowToTask = (row: Record<string, unknown>): Task => {
  const functional = (row.plan_functional as string | null) ?? null
  const technical = (row.plan_technical as string | null) ?? null
  const plan: TaskPlan | null =
    functional !== null || technical !== null
      ? { functional: functional ?? '', technical: technical ?? '' }
      : null
  const authorKindRaw = (row.author_kind as string | null) ?? null
  const authorName = (row.author_name as string | null) ?? null
  const author: Author | null =
    authorKindRaw === 'human' || authorKindRaw === 'agent'
      ? { kind: authorKindRaw as AuthorKind, name: authorName ?? 'unknown' }
      : null
  const fixForTaskId = (row.fix_for_task_id as string | null) ?? null
  const rawKind = (row.kind as string | null) ?? null
  const kind: TaskKind =
    rawKind === 'fix' || rawKind === 'task' || rawKind === 'diagnose'
      ? rawKind
      : deriveTaskKind(fixForTaskId)
  const rawTagsJson = (row.tags_json as string | null) ?? null
  let tags: TaskTag[]
  if (rawTagsJson !== null) {
    const parsed = parseStringArray(rawTagsJson).filter(isTaskTag)
    tags = parsed.length > 0 ? parsed : ['coder']
  } else {
    const rawTag = (row.tag as string | null) ?? null
    tags = [isTaskTag(rawTag) ? rawTag : 'coder']
  }
  return {
    id: row.id as string,
    prompt: coerceToString(row.prompt, 'rowToTask: prompt'),
    status: row.status as TaskStatus,
    plan,
    branch: (row.branch as string | null) ?? null,
    worktreePath: (row.worktree_path as string | null) ?? null,
    claudeSessionId: (row.claude_session_id as string | null) ?? null,
    claudeSessionIds: parseClaudeSessionIds(row.claude_session_ids),
    error: (row.error as string | null) ?? null,
    author,
    dropReason: (row.drop_reason as TaskDropReason | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    failureReasonCode: (row.failure_reason_code as string | null) ?? null,
    stallDiagnostics: (row.stall_diagnostics as string | null) ?? null,
    recoverySpawnedCount: Number(row.recovery_spawned_count ?? 0),
    envRestartCount: Number(row.env_restart_count ?? 0),
    fixForTaskId,
    failureSignature: (row.failure_signature as string | null) ?? null,
    kind,
    tags,
    originId: ((row.origin_id as string | null) ?? (row.id as string)),
    priority: Number(row.priority ?? 0),
    failedPhase: coerceFailedPhase(row.failed_phase),
    spec: rowToTaskSpec(row),
    integrationHeadSha: (row.integration_head_sha as string | null) ?? null,
    devServerUrl: (row.dev_server_url as string | null) ?? null,
    devServerPid:
      row.dev_server_pid === null || row.dev_server_pid === undefined
        ? null
        : Number(row.dev_server_pid),
    previewValidated: Number(row.preview_validated ?? 0) === 1,
    recoveryPayload: (row.recovery_payload as string | null) ?? null,
    intent: (row.intent as string | null) ?? '',
    leaseOwner: (row.lease_owner as string | null) ?? null,
    leasedAt: (row.leased_at as string | null) ?? null,
    leaseNote: (row.lease_note as string | null) ?? null,
    originSessionId: (row.origin_session_id as string | null) ?? null,
    workflow: (row.workflow as string | null) ?? null,
    currentStepName: (row.current_step_name as string | null) ?? null,
    currentStepGuide: (row.current_step_guide as string | null) ?? null,
    activityDetail: (row.activity_detail as string | null) ?? null,
    compensatesArcId: (row.compensates_arc_id as string | null) ?? null,
    qa: (row.qa as string | null) === 'manual' ? 'manual' : 'auto',
    requeueAnchorMs:
      row.requeue_anchor_ms === null || row.requeue_anchor_ms === undefined
        ? null
        : Number(row.requeue_anchor_ms),
    requeueDispatchUptimeMs:
      row.requeue_dispatch_uptime_ms === null || row.requeue_dispatch_uptime_ms === undefined
        ? null
        : Number(row.requeue_dispatch_uptime_ms),
    qaReport: parseQaReport(row.qa_report_json),
    deferrable: Number(row.deferrable ?? 0) === 1,
    quotaRejectedAttempts: Number(row.quota_rejected_attempts ?? 0),
    envApiUnreachableAttempts: Number(row.env_api_unreachable_attempts ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

// ---------------------------------------------------------------------------
// getTask — pure SELECT, no Arc dependency
// ---------------------------------------------------------------------------

/**
 * Query-only store interface for `getTask`. Accepts any object with a
 * `query` method matching the `DomainTaskStore.query` signature, avoiding
 * a value-import of the full store which would close a cycle through `arc.ts`.
 */
export interface ReadStore {
  query(stmt: DbStatement, params?: unknown[]): Promise<DbResultSet>
}

export const getTask = async (id: string, store?: ReadStore): Promise<Task | null> => {
  const stmt: DbStatement = { sql: `${TASK_SEL} WHERE t.id = ?`, args: [id] }
  let r: DbResultSet
  if (store) {
    r = await store.query(stmt)
  } else {
    await ensureQueueSchema()
    r = await resolveQueueClient().execute(stmt)
  }
  if (r.rows.length === 0) return null
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Arc writer port
// ---------------------------------------------------------------------------
//
// Breaks the `queue.ts` → `arc.ts` and `store/task-store.ts` → `arc.ts`
// back-edges. `arc.ts` self-registers at module-init time via
// `registerArcWriter()`; every call site that previously called `Arc.xxx()`
// now goes through `getArcWriter().xxx()` instead.
//
// The seam lives in this leaf rather than in `queue.ts` because ADR-0101 moved
// `updateTask` into `arc.ts`, so `queue.ts` is itself a runtime importer of
// `arc.ts` now — hosting the port there would make `arc.ts` → `queue.ts` a new
// runtime cycle. This module has no runtime edge to either, so `arc.ts` can
// import the registrar without closing one. `queue.ts` re-exports all three
// symbols, which is how `store/task-store.ts` reaches `getArcWriter`.

/**
 * Port interface for the Arc write operations that `queue.ts` and
 * `store/task-store.ts` need. `arc.ts` is the sole implementor; it registers
 * itself at module-load time so callers only need `getArcWriter`.
 */
export interface ArcWriterPort {
  createOrigin(
    spec: { prompt: string; plan?: TaskPlan; opts?: EnqueueTaskOptions },
    store?: TaskStore,
  ): Promise<Task>
  applyStatusWrite(input: {
    id: string
    fields: string[]
    args: unknown[]
    eventStmts: DbStatement[]
    store?: TaskStore
    appendSessionId?: boolean
    sessionIdStmt?: DbStatement
  }): Promise<void>
  reopenTerminalTask(id: string, reason: string, store?: TaskStore): Promise<void>
  reprioritize(id: string, priority: number): Promise<Task>
  setVerifyCmd(
    id: string,
    verifyCmd: string | null,
  ): Promise<{ id: string; verifyCmd: string | null }>
  drop(id: string, store?: TaskStore): Promise<DropTaskResult>
  insertReflection(corpusSize: number, store?: TaskStore): Promise<string>
  promoteDraftToTriaging(taskId: string): Promise<Task | null>
  promoteDraftToQueued(taskId: string, store?: TaskStore): Promise<Task | null>
  setReviewPacket(taskId: string, packet: ReviewPacket, store: TaskStore): Promise<void>
  setQaReport(taskId: string, report: QaReport, store: TaskStore): Promise<void>
}

let _arcWriter: ArcWriterPort | null = null

/**
 * Called once by `arc.ts` at module-load time to register the implementation.
 * Any call to {@link getArcWriter} before this throws a clear error.
 */
export const registerArcWriter = (impl: ArcWriterPort): void => {
  _arcWriter = impl
}

/**
 * Returns the registered Arc writer. Throws if `arc.ts` has not been imported
 * yet — ensure the module graph reaches `arc.ts` before calling queue
 * operations that need the Arc aggregate.
 */
export const getArcWriter = (): ArcWriterPort => {
  if (_arcWriter === null) {
    throw new Error(
      '[mars] Arc writer not registered — import core/arc.ts before calling ' +
        'queue operations that route through the Arc aggregate.',
    )
  }
  return _arcWriter
}
