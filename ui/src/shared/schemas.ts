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
  'under_investigation',
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
  /** Ordered user story texts. Absent on legacy daemon responses — defaults to []. */
  userStories: z.array(z.string()).optional().default([]),
})

/** Full proposal record returned by GET /api/proposals/:id. */
export const proposalDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  problem: z.string(),
  solution: z.string(),
  outOfScope: z.string(),
  notes: z.string(),
  status: z.string(),
  source: proposalSourceSchema,
  author: z.object({ kind: z.string(), name: z.string() }).nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  userStories: z.array(z.string()),
})
export type ProposalDetail = z.infer<typeof proposalDetailSchema>

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
  /**
   * Cheap aggregate counts for the header strip. Optional so the UI
   * degrades gracefully against a stale daemon that predates this field.
   * - doneToday: tasks completed in the last 24 hours (rolling window).
   * - doneTotal: all-time done count.
   * - failedOpen: tasks currently in status='failed'.
   */
  aggregates: z
    .object({
      doneToday: z.number(),
      doneTotal: z.number(),
      failedOpen: z.number(),
    })
    .optional()
    .default({ doneToday: 0, doneTotal: 0, failedOpen: 0 }),
})

export const todoResponseSchema = z.object({
  drafts: z.array(draftFeatureSchema),
  staleWorktrees: z.array(staleWorktreeSchema),
})

export const proposalsResponseSchema = z.object({
  drafts: z.array(draftFeatureSchema),
})

export const staleWorktreesResponseSchema = z.object({
  staleWorktrees: z.array(staleWorktreeSchema),
})

export const dagNodeSchema = z.object({
  id: z.string(),
  status: z.string(),
  summary: z.string(),
})

export const dagEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['blocks', 'recovers']),
})

export const dagContextSchema = z.object({
  blockers: z.array(dagNodeSchema),
  blocking: z.array(dagNodeSchema),
  descendants: z.array(dagNodeSchema),
  proposalId: z.string().nullable(),
  edges: z.array(dagEdgeSchema),
})

export const actionDescriptorSchema = z.object({
  id: z.string(),
  label: z.string(),
  op: z.string(),
  needsConfirm: z.boolean().optional(),
  hint: z.string().optional(),
})

// Resolution metadata carried by resolved rows (history). Non-null only on
// rows returned by GET /api/action-queue/history.
export const actionQueueResolutionSchema = z.object({
  resolvedAt: z.string(),
  resolution: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  rootCause: z.string().nullable(),
  resolvedBy: z.string().nullable(),
})

export type ActionQueueResolution = z.infer<typeof actionQueueResolutionSchema>

// Shared base schema — fields present on every action-queue row regardless of kind.
const actionQueueBaseSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  priority: z.enum(['high', 'normal', 'low']),
  title: z.string(),
  body: z.string(),
  at: z.string(),
  dag: dagContextSchema.nullable(),
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
  /**
   * When this row represents a fix/recovery task, the id of the origin task it
   * was spawned to fix. Null/absent for origin tasks or non-failed rows.
   * Drives the "Fix for: <origin>" navigable link in the failure card.
   */
  fixForTaskId: z.string().nullable().optional(),
  /**
   * Resolution metadata — non-null on history rows, absent/null on live open rows.
   * The UI uses this to render the Resolution block and suppress action buttons.
   */
  resolution: actionQueueResolutionSchema.nullish(),
  /**
   * Live preview dev-server URL for an 'awaiting-validation' row (e.g.
   * `http://127.0.0.1:4321`). Null/absent on every other row kind. Rendered as a
   * clickable link the operator opens before clicking Validate / Reject.
   */
  devServerUrl: z.string().nullable().optional(),
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

const awaitingValidationItemSchema = actionQueueBaseSchema.extend({
  kind: z.literal('awaiting-validation'),
})

/**
 * One node in the alert's Proposal-to-Attempt chain.
 * Ordered oldest → newest: proposal head (if any), origin task (attemptIndex=1),
 * operator-initiated restarts (attemptIndex=2, 3, …), automatic recovery tasks.
 */
const alertChainNodeSchema = z.object({
  kind: z.enum(['proposal', 'task']),
  id: z.string(),
  status: z.string().optional(),
  label: z.string(),
  attemptIndex: z.number().optional(),
})

/**
 * Arc-rooted alert row: every task in the arc is terminal with no success.
 * Carries the three-level goal → reason → technical hierarchy from the Alert
 * read aggregate (ADR-0054). The `title` and `body` base fields carry the same
 * goal and technical detail respectively for backward-compatible row rendering;
 * the named `goal` and `reason` fields exist so the detail panel can surface
 * them as distinct typographic levels without concatenating.
 */
const arcFailedItemSchema = actionQueueBaseSchema.extend({
  kind: z.literal('arc-failed'),
  /** One-line intent: what the arc was trying to achieve. */
  goal: z.string(),
  /** Warm, human-readable failure cause (FailureKind copy). */
  reason: z.string(),
  /** Ordered arc lineage: proposal head → origin attempt → restarts → recoveries. */
  chain: z.array(alertChainNodeSchema),
})

export const actionQueueItemSchema = z.discriminatedUnion('kind', [
  failedTaskItemSchema,
  staleWorktreeItemSchema,
  draftProposalItemSchema,
  awaitingValidationItemSchema,
  arcFailedItemSchema,
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
  /**
   * The arc this session's step ran for (trace event origin_id, else
   * task_id). Joins sessions against per-arc data such as the spend meter's
   * over-ceiling arcs. `.catch(null)` tolerates a daemon predating the field.
   */
  arcId: z.string().nullable().catch(null),
})

export const workerSessionsResponseSchema = z.object({
  sessions: z.array(workerSessionSchema),
})

export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>
export type WorkerSession = z.infer<typeof workerSessionSchema>

// ----------------------------------------------------------------------------
// Spend meter (daemon `/budget` → proxied as `/api/budget`).
// Observe-and-warn token-budget alerting — explicitly NOT a fifth KPI; the
// tile only reuses the KpiBand cue vocabulary for rendering. Units are raw
// cache-weighted tokens (input + output + cacheCreate + cacheRead*0.1).
// ----------------------------------------------------------------------------

export const spendBandSchema = z.enum(['good', 'warn', 'bad'])

export const budgetArcSpendSchema = z.object({
  arcId: z.string(),
  spendTokens: z.number(),
})

export const budgetStatusSchema = z.object({
  configured: z.boolean(),
  config: z
    .object({
      windowMs: z.number().nullable(),
      windowTokens: z.number().nullable(),
      arcTokens: z.number().nullable(),
    })
    .nullable(),
  window: z
    .object({
      windowMs: z.number(),
      thresholdTokens: z.number(),
      spendTokens: z.number(),
      ratio: z.number(),
      band: spendBandSchema,
      topArcs: z.array(budgetArcSpendSchema),
    })
    .nullable(),
  arcs: z
    .object({
      ceilingTokens: z.number(),
      liveArcs: z.array(
        budgetArcSpendSchema.extend({
          ratio: z.number(),
          overCeiling: z.boolean(),
        }),
      ),
    })
    .nullable(),
  openRows: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['budget-window', 'budget-arc']),
      signature: z.string().nullable(),
      title: z.string(),
      raisedAt: z.string(),
      lastSeenAt: z.string(),
      seenCount: z.number(),
    }),
  ),
})

export type SpendBand = z.infer<typeof spendBandSchema>
export type BudgetStatus = z.infer<typeof budgetStatusSchema>

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

export const kpiSeriesPointSchema = z.object({
  takenAt: z.string(),
  value: z.number().nullable(),
})

export type KpiSeriesPoint = z.infer<typeof kpiSeriesPointSchema>

export const kpiSchema = z.object({
  key: kpiKeySchema,
  currentValue: z.number(),
  priorValue: z.number(),
  delta: z.number(),
  sampleCount: z.number(),
  lowConfidence: z.boolean(),
  series: z.array(kpiSeriesPointSchema).optional(),
})

export const kpisResponseSchema = z.object({
  kpis: z.array(kpiSchema),
})

export type KpiKey = z.infer<typeof kpiKeySchema>
export type Kpi = z.infer<typeof kpiSchema>
export type KpisPayload = z.infer<typeof kpisResponseSchema>

// ----------------------------------------------------------------------------
// KPI arcs (GET /api/kpis/:key/arcs). Per-arc breakdown behind a KPI value.
// Each row is one arc (or recovery sample for recovery_success_rate) with a
// PASS/FAIL classification that mirrors the kpi-compute.ts grouping logic.
// For cost_per_arc, `passed` is always true and `costTokens` carries the
// cache-weighted token cost so the user sees the distribution.
// ----------------------------------------------------------------------------

export const kpiArcSchema = z.object({
  /** The arc id (COALESCE(origin_id, id)). */
  arcId: z.string(),
  /** The origin task id for this arc (may differ from arcId for recovery samples). */
  originTaskId: z.string(),
  /** Human-readable task prompt / title (first 120 chars). */
  title: z.string(),
  /** Terminal status of the arc. */
  status: z.string(),
  /** Whether this arc PASSED the KPI's classification criterion. */
  passed: z.boolean(),
  /**
   * Cache-weighted token cost — only present for cost_per_arc arcs.
   * Absent (undefined) for all other KPI keys.
   */
  costTokens: z.number().optional(),
})

export const kpiArcsResponseSchema = z.object({
  key: kpiKeySchema,
  window: z.object({
    windowStart: z.string(),
    windowEnd: z.string(),
  }),
  arcs: z.array(kpiArcSchema),
})

export type KpiArc = z.infer<typeof kpiArcSchema>
export type KpiArcsResponse = z.infer<typeof kpiArcsResponseSchema>

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
  selfUpdatable: z.boolean(),
})

export type FrameworkUpdate = z.infer<typeof frameworkUpdateSchema>

// ----------------------------------------------------------------------------
// Action queue history (GET /api/action-queue/history).
// A cursor-paged list of resolved rows with resolution metadata.
// ----------------------------------------------------------------------------

export const actionQueueHistoryResponseSchema = z.object({
  rows: z.array(
    actionQueueItemSchema.catch((ctx) => {
      const raw =
        typeof ctx.input === 'object' && ctx.input !== null
          ? (ctx.input as Record<string, unknown>)
          : {}
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
  ),
  nextCursor: z.string().nullable(),
})

export type ActionQueueHistoryResponse = z.infer<typeof actionQueueHistoryResponseSchema>

export type ActionQueueItem = z.infer<typeof actionQueueItemSchema>
export type ActionDescriptor = z.infer<typeof actionDescriptorSchema>
export type AlertChainNode = z.infer<typeof alertChainNodeSchema>
export type DagNode = z.infer<typeof dagNodeSchema>
export type DagEdge = z.infer<typeof dagEdgeSchema>
export type DagContext = z.infer<typeof dagContextSchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
export type ProposalSource = z.infer<typeof proposalSourceSchema>
export type DraftFeature = z.infer<typeof draftFeatureSchema>
export type Task = z.infer<typeof taskSchema>
export type Cluster = z.infer<typeof clusterSchema>
export type ProgressTask = z.infer<typeof progressTaskSchema>
export type ProgressProposalNode = z.infer<typeof progressProposalNodeSchema>
export type StaleWorktree = z.infer<typeof staleWorktreeSchema>
export type ProposalsPayload = z.infer<typeof proposalsResponseSchema>
export type StaleWorktreesPayload = z.infer<typeof staleWorktreesResponseSchema>

// ----------------------------------------------------------------------------
// Release notes (GET /api/release-notes). Arc-grouped landed tasks, newest
// first. Mirrors the ReleaseNoteEntry / ReleaseNoteSpec interfaces in
// ui/server/releaseNotes.ts.
// ----------------------------------------------------------------------------

const releaseNoteSpecSchema = z.object({
  files: z.array(z.string()),
  verifyCmd: z.string().nullable(),
  doneCriteria: z.array(z.string()),
})

export const releaseNoteEntrySchema = z.object({
  originId: z.string(),
  title: z.string(),
  landedAt: z.string(),
  detail: z.object({
    prompt: z.string(),
    spec: releaseNoteSpecSchema.nullable(),
    recoveryCount: z.number(),
  }),
})

export const releaseNotesResponseSchema = z.array(releaseNoteEntrySchema)

export type ReleaseNoteSpec = z.infer<typeof releaseNoteSpecSchema>
export type ReleaseNoteEntry = z.infer<typeof releaseNoteEntrySchema>

// ----------------------------------------------------------------------------
// Release notes cursor (GET/POST /api/release-notes-cursor). Tracks when the
// user last viewed the release notes, per project.
// ----------------------------------------------------------------------------

export const releaseNotesCursorSchema = z.object({
  lastViewedAt: z.string().nullable(),
})

export type ReleaseNotesCursor = z.infer<typeof releaseNotesCursorSchema>

// ----------------------------------------------------------------------------
// Chat (GET /api/chat/threads, GET /api/chat/thread/:id, POST /api/chat/threads)
// A chat thread holds an ordered list of messages each composed of typed
// content segments (text / thinking / tool_use) from the Claude API.
// ----------------------------------------------------------------------------

export const chatSegmentTextSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const chatSegmentThinkingSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
})

export const chatSegmentToolUseSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  toolName: z.string(),
  /** Raw input sent to the tool — any JSON value. */
  input: z.unknown().optional(),
  /** Raw output from the tool — any JSON value. */
  result: z.unknown().optional(),
  /** True when the tool returned an error result. */
  isError: z.boolean().optional().default(false),
  /** 'pending' while the tool is in-flight; 'complete'/'error' once done. */
  status: z.enum(['pending', 'complete', 'error']).optional().default('complete'),
})

/** Alert action button rendered on the alert card. */
export const chatSegmentAlertActionSchema = z.object({
  op: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'destructive', 'default']),
})

/**
 * Alert segment: a rich card embedded in the opening message of a proactive
 * alert-origin chat thread. Contains enough info to render the card and invoke
 * actions without re-fetching the action queue.
 */
export const chatSegmentAlertSchema = z.object({
  type: z.literal('alert'),
  /** The ActionQueueKind of the underlying item (e.g. 'failed', 'draft-proposal'). */
  kind: z.string(),
  /** Entity id (task id, proposal id, etc.) the alert is about. */
  entityId: z.string(),
  priority: z.string(),
  title: z.string(),
  /** Human-readable explanation of why this alert appeared now. */
  whyNow: z.string(),
  actions: z.array(chatSegmentAlertActionSchema),
  /** True once the underlying action-queue item has been superseded/resolved. */
  resolved: z.boolean().optional().default(false),
})

export const chatSegmentSchema = z.discriminatedUnion('type', [
  chatSegmentTextSchema,
  chatSegmentThinkingSchema,
  chatSegmentToolUseSchema,
  chatSegmentAlertSchema,
])

export const chatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(['user', 'assistant']),
  /** Segments; defaults to empty array for legacy messages that have no segments. */
  segments: z.array(chatSegmentSchema).optional().default([]),
  createdAt: z.string(),
})

export const chatThreadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  /** 'running' while a response is being streamed; 'idle' otherwise. */
  status: z.enum(['idle', 'running']),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().optional().default(0),
  /** 'alert' for proactive alert-origin threads; null for user-created threads. */
  origin: z.string().nullable().optional(),
  /** The action-queue item id this thread tracks; null for non-alert threads. */
  alertItemId: z.string().nullable().optional(),
  /** True when the underlying action-queue item has been resolved. */
  alertResolved: z.boolean().optional().default(false),
})

export const chatThreadsResponseSchema = z.object({
  threads: z.array(chatThreadSchema),
})

export const chatThreadDetailSchema = z.object({
  thread: chatThreadSchema,
  messages: z.array(chatMessageSchema),
})

export type ChatSegmentAlertAction = z.infer<typeof chatSegmentAlertActionSchema>
export type ChatSegmentAlert = z.infer<typeof chatSegmentAlertSchema>
export type ChatSegment = z.infer<typeof chatSegmentSchema>
export type ChatSegmentText = z.infer<typeof chatSegmentTextSchema>
export type ChatSegmentThinking = z.infer<typeof chatSegmentThinkingSchema>
export type ChatSegmentToolUse = z.infer<typeof chatSegmentToolUseSchema>
export type ChatMessage = z.infer<typeof chatMessageSchema>
export type ChatThread = z.infer<typeof chatThreadSchema>
export type ChatThreadsResponse = z.infer<typeof chatThreadsResponseSchema>
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

export const glossaryTermSchema = z.object({
  term: z.string(),
  definition: z.string(),
  avoid: z.array(z.string()),
})

export const glossaryResponseSchema = z.object({
  terms: z.array(glossaryTermSchema),
})

export type GlossaryTerm = z.infer<typeof glossaryTermSchema>
export type GlossaryResponse = z.infer<typeof glossaryResponseSchema>

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
})

export const skillsResponseSchema = z.object({
  skills: z.array(skillSchema),
})

export type Skill = z.infer<typeof skillSchema>
export type SkillsResponse = z.infer<typeof skillsResponseSchema>
