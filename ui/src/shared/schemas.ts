import { z } from 'zod'

const taskStatusSchema = z.enum([
  'draft',
  'queued',
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
  'done',
  'failed',
  'dropped',
  'blocked',
])

const proposalSourceSchema = z.enum(['reflection', 'human', 'planner'])

const draftFeatureSchema = z.object({
  id: z.string(),
  title: z.string(),
  problem: z.string(),
  solution: z.string(),
  status: z.string(),
  source: proposalSourceSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  acceptanceCount: z.number(),
})

const taskPlanSchema = z
  .object({
    functional: z.string(),
    technical: z.string(),
  })
  .nullable()

const taskSpecSchema = z
  .object({
    files: z.array(z.string()),
    readFirst: z.array(z.string()),
    prescriptiveAction: z.string().nullable(),
    verifyCmd: z.string().nullable(),
    doneCriteria: z.array(z.string()),
    taskType: z.string(),
  })
  .nullable()

export const taskSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  status: taskStatusSchema,
  plan: taskPlanSchema,
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  error: z.string().nullable(),
  dropReason: z.string().nullable(),
  retryCount: z.number(),
  blockerTaskId: z.string().nullable(),
  /**
   * Machine-readable failure signature stamped at failure time (e.g.
   * `'daemon-killed'`). The server already computes and serialises this; the
   * task detail drawer surfaces it under the failure banner. Null/absent for
   * non-failed or legacy rows.
   */
  failureSignature: z.string().nullable().optional(),
  /**
   * Full list of blocker task IDs. Empty array for tasks with no blockers.
   * Drives the Topology tab's DAG edges without a second round-trip.
   */
  blockedBy: z.array(z.string()).optional().default([]),
  /**
   * The proposal this task was sliced from. Null for ad-hoc tasks.
   * Drives provenance edges in the Topology DAG view.
   */
  parentProposalId: z.string().nullable().optional(),
  spec: taskSpecSchema.optional().nullable(),
  /**
   * Stable arc-origin id — groups this task with its fix/diagnose siblings in
   * the Topology view. Null for legacy rows that predate arc tracking.
   */
  originId: z.string().nullable().optional(),
  /**
   * Id of the task this row is fixing. Non-null iff kind='fix'.
   * Drives the fix-edge in the arc topology graph.
   */
  fixForTaskId: z.string().nullable().optional(),
  /**
   * Task role: 'task' | 'fix' | 'diagnose'. Null for legacy rows.
   * Used to distinguish the arc origin from its recovery tasks.
   */
  kind: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const clusterSchema = z.enum(['Queued', 'In progress', 'Blocked', 'Failed'])

const progressTaskSchema = taskSchema.extend({
  cluster: clusterSchema,
})

/**
 * A Proposal node surfaced in the Progress DAG view.
 * Only proposals that have at least one in-scope sliced task are included.
 */
const progressProposalNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: proposalSourceSchema,
  status: z.string(),
})

const staleWorktreeSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  ageHours: z.number(),
  updatedAt: z.string(),
  prompt: z.string(),
  error: z.string().nullable(),
  branch: z.string().nullable(),
  blockerTaskId: z.string().nullable(),
})

export const tasksResponseSchema = z.object({
  tasks: z.array(taskSchema),
})

export const progressResponseSchema = z.object({
  tasks: z.array(progressTaskSchema),
  /**
   * Proposals that have at least one in-scope sliced task.
   * Drives Proposal nodes and provenance edges in the DAG view.
   */
  proposals: z.array(progressProposalNodeSchema).optional().default([]),
})

export const todoResponseSchema = z.object({
  drafts: z.array(draftFeatureSchema),
  staleWorktrees: z.array(staleWorktreeSchema),
})

export const dagNodeSchema = z.object({
  id: z.string(),
  status: z.string(),
  summary: z.string(),
})

export const dagContextSchema = z.object({
  blockers: z.array(dagNodeSchema),
  blocking: z.array(dagNodeSchema),
  descendants: z.array(dagNodeSchema),
  proposalId: z.string().nullable(),
})

export const actionDescriptorSchema = z.object({
  id: z.string(),
  label: z.string(),
  op: z.string(),
  needsConfirm: z.boolean().optional(),
  hint: z.string().optional(),
})

// Shared base schema — fields present on every action-queue row regardless of kind.
const actionQueueBaseSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  priority: z.enum(['high', 'normal', 'low']),
  title: z.string(),
  body: z.string(),
  at: z.string(),
  dag: dagContextSchema.nullable(),
  dismissed: z.boolean(),
  /**
   * The specific operator action recorded against this row, or null when no
   * action has been taken. 'ack' items remain visible in the open filter;
   * 'resolved' and 'dismissed' items are hidden from it.
   */
  ackState: z.enum(['ack', 'resolved', 'dismissed']).nullable(),
  // Machine-readable error-kind key the row resolves to (a superset of `kind`:
  // a daemon-killed failure resolves to 'daemon-killed', not 'failed-task').
  errorKind: z.string(),
  // Recovery actions composed from the error-kind registry. Empty when the
  // daemon is unreachable.
  actions: z.array(actionDescriptorSchema),
  /**
   * Root-cause diagnosis written by the diagnose-failure action, or null when
   * none has been run. Only populated for failed-task rows; kept on the base so
   * call sites can access it without narrowing on kind.
   */
  diagnosis: z
    .object({
      text: z.string(),
      diagnosedAt: z.string(),
    })
    .nullish(),
  /**
   * The failure signature (`<failingStep>/<error-class>`) mirrored onto the
   * row (ADR-0042). The detail panel renders the reason from the row's `body`
   * and the recovery menu from `actions`, both derived daemon-side from the
   * signature-keyed Failure kind record. Null on non-failed rows and on legacy
   * rows landed before the signature was written everywhere.
   */
  failureReasonCode: z.string().nullable().optional(),
})

// Detail block carried by every 'stale-worktree' row — absent on all other kinds.
const staleWorktreeDetailSchema = z.object({
  /** Task prompt, or null when no matching task row exists. */
  prompt: z.string().nullable(),
  /** Task status string, or 'absent (no matching task)' when the task row is missing. */
  status: z.string(),
  /** Worktree age in hours (derived from task updatedAt). */
  ageHours: z.number(),
  /** ISO timestamp of the task's last update. */
  updatedAt: z.string(),
  /** Worktree branch (task/<id>), or null when not resolvable. */
  branch: z.string().nullable(),
  /**
   * True when the worktree has no diff against the merge-base with main
   * AND no untracked files. False when git is unavailable or the worktree
   * directory is absent (conservative: assume non-empty).
   */
  empty: z.boolean(),
  /**
   * Investigation text written by the investigate action, or null when
   * no investigation has been run yet.
   */
  investigation: z.string().nullable(),
})

const failedTaskItemSchema = actionQueueBaseSchema.extend({
  kind: z.literal('failed-task'),
})

const staleWorktreeItemSchema = actionQueueBaseSchema.extend({
  kind: z.literal('stale-worktree'),
  /**
   * Populated only for stale-worktree rows; always an object (never null/absent)
   * because the server always constructs it before emitting a stale-worktree item.
   * Replaces the former .nullish() on the flat schema — absent on all other kinds.
   */
  staleWorktreeDetail: staleWorktreeDetailSchema,
})

const draftProposalItemSchema = actionQueueBaseSchema.extend({
  kind: z.literal('draft-proposal'),
})

export const actionQueueItemSchema = z.discriminatedUnion('kind', [
  failedTaskItemSchema,
  staleWorktreeItemSchema,
  draftProposalItemSchema,
])

// Element-level catch: when a row has an unrecognised 'kind' value (e.g. a stale
// persisted row) or is otherwise malformed, coerce it to the failed-task variant
// rather than rejecting the whole array. This preserves the safety net that the
// old flat-enum '.catch("failed-task")' gave on the discriminator — one bad row
// must not fail a 300-row response.
export const actionQueueResponseSchema = z.array(
  actionQueueItemSchema.catch((ctx) => {
    const raw =
      typeof ctx.input === 'object' && ctx.input !== null
        ? (ctx.input as Record<string, unknown>)
        : {}
    // Re-parse with kind overridden to 'failed-task'; preserves all other base
    // fields the failed-task variant accepts. Falls back to a minimal sentinel
    // when even the failed-task variant rejects the row.
    const attempt = failedTaskItemSchema.safeParse({ ...raw, kind: 'failed-task' })
    if (attempt.success) return attempt.data
    return {
      id: typeof raw.id === 'string' ? raw.id : 'unknown',
      kind: 'failed-task' as const,
      entityId: typeof raw.entityId === 'string' ? raw.entityId : '',
      priority: 'high' as const,
      title: typeof raw.title === 'string' ? raw.title : '',
      body: typeof raw.body === 'string' ? raw.body : '',
      at: '1970-01-01T00:00:00.000Z',
      dag: null,
      dismissed: false,
      ackState: null,
      errorKind:
        typeof raw.errorKind === 'string'
          ? raw.errorKind
          : typeof raw.kind === 'string'
            ? raw.kind
            : 'unknown',
      actions: [],
      diagnosis: null,
      failureReasonCode: null,
    }
  }),
)

// ----------------------------------------------------------------------------
// Worker Sessions (GET /api/sessions?agentName=X)
// Per-step execution spans where a Worker ran claude -p, queryable by worker
// name. Outcome is the closed {running, completed, failed, killed} set from
// ADR-0021; 'running' spans are open step_started events with no step_ended.
// ----------------------------------------------------------------------------

export const sessionOutcomeSchema = z.enum([
  'running',
  'completed',
  'failed',
  'killed',
])

export const workerSessionSchema = z.object({
  /** Trace event id for the step_ended row. */
  id: z.string(),
  /** Claude session id from the step_ended payload, or null when not recorded. */
  sessionId: z.string().nullable(),
  /** Worker that ran this session (e.g. 'Coder', 'Fixer'). */
  workerName: z.string(),
  /** Step name within the workflow (e.g. 'run-claude-code'). */
  stepName: z.string(),
  /** Workflow instance id this session belonged to. */
  workflowInstanceId: z.string(),
  /** How the session ended. */
  outcome: sessionOutcomeSchema,
  /** ISO timestamp when the step_ended event was recorded (= span end time). */
  endedAt: z.string(),
  /** Duration in milliseconds, or null when the payload did not include it. */
  durationMs: z.number().nullable(),
})

export const workerSessionsResponseSchema = z.object({
  sessions: z.array(workerSessionSchema),
})

export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>
export type WorkerSession = z.infer<typeof workerSessionSchema>

// ----------------------------------------------------------------------------
// Trace events (daemon `/events` → proxied as `/api/trace-events`).
// ----------------------------------------------------------------------------

export const traceEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  kind: z.string(),
  severity: z.enum(['info', 'warn', 'error']).catch('info'),
  taskId: z.string().nullable(),
  originId: z.string().nullable(),
  phase: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
})

export const eventsResponseSchema = z.object({
  events: z.array(traceEventSchema),
  nextCursor: z.string().nullable(),
})

// ----------------------------------------------------------------------------
// Origin tree (daemon `/origins/:taskId` → proxied as `/api/origins/:taskId`).
// The tree is recursive, so the schema declares the leaf shape and patches
// `children` via z.lazy. We use an explicit ZodType type annotation so the
// recursive inference compiles.
// ----------------------------------------------------------------------------

export type OriginNode = {
  id: string
  kind: string
  title: string
  status: string
  children: OriginNode[]
}

const baseOriginNodeShape = {
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  status: z.string(),
}

export const originNodeSchema: z.ZodType<OriginNode> = z.object({
  ...baseOriginNodeShape,
  children: z.lazy(() => z.array(originNodeSchema)),
})

export const originsResponseSchema = z.object({
  node: originNodeSchema,
})

export type TraceEvent = z.infer<typeof traceEventSchema>
export type EventsResponse = z.infer<typeof eventsResponseSchema>
export type OriginsResponse = z.infer<typeof originsResponseSchema>

// ----------------------------------------------------------------------------
// KPIs (daemon `/kpis` → proxied as `/api/kpis`). The four-KPI vector from
// the harness-health ADR (originally numbered 0038 on main; our rework
// branch's recovery-tasks-leaf-node ADR was renumbered to 0040 during the
// merge).
// ----------------------------------------------------------------------------

export const kpiKeySchema = z.enum([
  'cost_per_arc',
  'failure_rate',
  'autonomous_completion_rate',
  'recovery_success_rate',
])

export const kpiSchema = z.object({
  key: kpiKeySchema,
  currentValue: z.number(),
  priorValue: z.number(),
  delta: z.number(),
  sampleCount: z.number(),
  lowConfidence: z.boolean(),
})

export const kpisResponseSchema = z.object({
  kpis: z.array(kpiSchema),
})

export type KpiKey = z.infer<typeof kpiKeySchema>
export type Kpi = z.infer<typeof kpiSchema>
export type KpisPayload = z.infer<typeof kpisResponseSchema>

// ----------------------------------------------------------------------------
// Projects (GET /api/projects). Multi-project dashboard — each entry is one
// mars repo managed by a separate daemon. health reflects the current daemon
// liveness: live (responsive), degraded (slow / partial), down (unreachable).
// ----------------------------------------------------------------------------

export const daemonHealthSchema = z.enum(['live', 'degraded', 'down'])

export const projectSchema = z.object({
  projectId: z.string(),
  repoRoot: z.string(),
  name: z.string(),
  health: daemonHealthSchema,
})

export const projectsResponseSchema = z.object({
  projects: z.array(projectSchema),
})

export type DaemonHealth = z.infer<typeof daemonHealthSchema>
export type Project = z.infer<typeof projectSchema>

// ----------------------------------------------------------------------------
// Framework update availability (daemon `/view/framework-update` →
// proxied as `/api/framework-update`). Reflects the installed vs latest
// version state; the actual self-update action is a separate task.
// ----------------------------------------------------------------------------

export const frameworkUpdateSchema = z.object({
  installed: z.string(),
  latest: z.string(),
  available: z.boolean(),
  checkedAt: z.string().nullable(),
  releaseUrl: z.string().nullable(),
})

export type FrameworkUpdate = z.infer<typeof frameworkUpdateSchema>

export type ActionQueueItem = z.infer<typeof actionQueueItemSchema>
export type ActionDescriptor = z.infer<typeof actionDescriptorSchema>
export type DagNode = z.infer<typeof dagNodeSchema>
export type DagContext = z.infer<typeof dagContextSchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
export type ProposalSource = z.infer<typeof proposalSourceSchema>
export type DraftFeature = z.infer<typeof draftFeatureSchema>
export type Task = z.infer<typeof taskSchema>
export type Cluster = z.infer<typeof clusterSchema>
export type ProgressTask = z.infer<typeof progressTaskSchema>
export type ProgressProposalNode = z.infer<typeof progressProposalNodeSchema>
export type StaleWorktree = z.infer<typeof staleWorktreeSchema>
export type TodoPayload = z.infer<typeof todoResponseSchema>
