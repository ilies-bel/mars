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

// Mirrors ProposalSource in orchestrator/src/core/proposals.ts. Kept as a
// literal list rather than an import so the browser bundle never pulls the
// orchestrator's node-only modules in; add every new producer here too.
const proposalSourceSchema = z.enum([
  'reflection',
  'arc-verifier',
  'human',
  'planner',
  'skill-forge',
  'failure-reflector',
])

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
    mergeMode: z.string(),
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
  priority: z.number(),
  blockerTaskId: z.string().nullable().optional(),
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
  /**
   * When set, this task was created to compensate/cleanup a force-purged arc.
   * The value is the `origin_id` of the abandoned arc. Null for all other tasks.
   * Used by the board to show the arc lifecycle (compensation badge/indicator).
   */
  compensatesArcId: z.string().nullable().optional(),
  /**
   * Short-lived sub-phase label for an in-flight task (e.g. `merge:fast-forward`).
   * Null/absent for queued/done/failed tasks.
   */
  activityDetail: z.string().nullable().optional(),
  /**
   * Short human-readable summary set at enqueue. Card titles prefer this over
   * `prompt`, which is routinely a multi-paragraph brief on a single line and
   * makes the board unscannable. Null/absent on legacy rows.
   */
  intent: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const clusterSchema = z.enum(['Queued', 'In progress', 'Blocked', 'Failed', 'Done'])

const progressTaskSchema = taskSchema.extend({
  cluster: clusterSchema,
  /**
   * Flat done criteria hoisted from spec.doneCriteria. Client-only parse
   * widening — the server may send these nested in `spec`; this field accepts
   * them when the server returns them flat (e.g. via a future API update or a
   * test fixture). Absent on legacy rows.
   */
  doneCriteria: z.array(z.string()).optional(),
  /**
   * Flat verify command hoisted from spec.verifyCmd. Same client-only widening
   * rationale as doneCriteria above.
   */
  verify: z.string().nullable().optional(),
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
  blockerTaskId: z.string().nullable().optional(),
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

/**
 * Ordered, styled verb button from the per-kind recipe.
 * 'snooze' style opens the preset menu rather than immediately invoking the op.
 */
export const alertVerbSchema = z.object({
  op: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'destructive', 'default', 'snooze']),
  /** Client-side hint text — e.g. the command to copy for a 'copy' op. */
  hint: z.string().optional(),
})

/**
 * A server-defined decision button. Each Decision maps to exactly one button
 * on the AlertCard. Clicking POSTs `payload` to `endpoint`. `secondary` is
 * an optional follow-up prompt spec rendered after the POST returns.
 */
export const zDecision = z.object({
  label: z.string(),
  endpoint: z.string(),
  payload: z.record(z.string(), z.unknown()).default({}),
  secondary: z
    .object({
      kind: z.enum(['teach-recipe', 'scope-choice']),
      prompt: z.string(),
    })
    .optional(),
})

/**
 * Structured detail block revealed behind the "Details ▸" expander on alert cards.
 * All fields are optional — the backend only populates fields relevant to the
 * specific alert kind (e.g. rawError for failed tasks, changelog for update kinds).
 */
export const alertHumanDetailSchema = z.object({
  failureSignature: z.string().optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  rawError: z.string().optional(),
  /** Rendered as markdown on update-kind alerts. */
  changelog: z.string().optional(),
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
   * The main intent of the arc. For origin failed-task rows this is the task's
   * own prompt (truncated). For recovery/fix rows this is the ORIGIN task's
   * prompt so the operator sees what was being attempted, not just that
   * recovery failed. Absent on non-task-backed rows and daemon versions that
   * predate this field.
   */
  arcGoal: z.string().nullable().optional(),
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
  /**
   * Plain-language headline from the per-kind recipe. Falls back to empty for
   * rows from daemon versions predating recipe fields.
   */
  humanSummary: z.string().optional().default(''),
  /** Structured detail block for the "Details ▸" expander. */
  humanDetail: alertHumanDetailSchema.optional(),
  /**
   * Ordered, styled verb buttons from the per-kind recipe.
   * Falls back to empty for daemon versions predating recipe fields.
   */
  verbs: z.array(alertVerbSchema).optional().default([]),
  /** ISO timestamp until which this row is snoozed. Absent when not snoozed. */
  snoozeUntil: z.string().optional(),
  /**
   * Server-defined decision buttons. Each entry maps to exactly one button on
   * the AlertCard — no client-side switch on failure kind required.
   * Falls back to empty for daemon versions predating this field.
   */
  decisions: z.array(zDecision).default([]),
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

// The daemon classifies every ActionQueueKind outside NON_TASK_FAILURE_KINDS as
// a task failure. This is that finite complement, copied from the daemon's
// ActionQueueKind vocabulary so task-failure rows retain their raw wire kind.
const taskFailureKinds = [
  'failed',
  'steward-repeat',
  'cancelled-blocker-cascade',
  'diagnose-inconclusive',
  'daemon-killed',
  'coder-question',
  'daemon-died',
  'worktree-ahead',
  'prerequisite-failed',
  'slices-dropped',
  'behaviour-unverified',
  'subscriber-stalled',
  'observability-store-oversize',
  'orphaned-origin',
  'phantom-task',
  'outbox-lag',
  'plan-approval',
  'done-with-unmerged-commits',
  'api-outage',
  'daemon-code-drift',
  'workflow-install-drift',
  'provider-rate-limited',
  'gate-broken',
  'gate-enrichment',
  'budget-window',
  'budget-arc',
  'promotion-decision',
  'arc-verification-failed',
  'signature-storm',
  'gate-enrichment-stale',
  'env-incident',
  'stale-queued',
  'stale-queued-summary',
  'spend-control-notice',
  'scheduling-decision',
  'requeue-warning',
] as const

/** Mirrors the daemon's task-failure classification for persisted kinds. */
export const isTaskFailureActionQueueKind = (kind: string): boolean =>
  (taskFailureKinds as readonly string[]).includes(kind)

const taskFailureItemSchema = actionQueueBaseSchema.extend({
  kind: z.enum(taskFailureKinds),
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

/**
 * Lease state carried on awaiting-human rows.
 * The UI renders the owner, timestamp, and optional note so the operator
 * can see who holds the worktree and why.
 */
const leaseStateSchema = z.object({
  leaseOwner: z.string(),
  leasedAt: z.string(),
  leaseNote: z.string().nullable(),
})

/**
 * A task is parked awaiting foreground human input (manual pipeline step).
 * Carries optional lease state indicating who holds the worktree.
 */
const awaitingHumanItemSchema = actionQueueBaseSchema.extend({
  kind: z.literal('awaiting-human'),
  /**
   * Current lease holder — present when a Foreground session owns the
   * worktree; null/absent when no session has been attached.
   */
  leaseState: leaseStateSchema.nullable().optional(),
})

/**
 * The reflect subsystem has suggested one or more proposals to review.
 * No extra fields beyond the base schema.
 */
const reflectRecommendedItemSchema = actionQueueBaseSchema.extend({
  kind: z.literal('reflect-recommended'),
})

/**
 * The scorer has surfaced a suggestion that requires human review.
 * No extra fields beyond the base schema.
 */
const scorerSuggestedItemSchema = actionQueueBaseSchema.extend({
  kind: z.literal('scorer-suggested'),
})

export const actionQueueItemSchema = z.union([
  staleWorktreeItemSchema,
  draftProposalItemSchema,
  awaitingValidationItemSchema,
  arcFailedItemSchema,
  awaitingHumanItemSchema,
  reflectRecommendedItemSchema,
  scorerSuggestedItemSchema,
  taskFailureItemSchema,
])

// Element-level catch: malformed rows must not reject an entire queue response.
// Valid daemon task-failure kinds parse above with their persisted kind intact;
// this fallback is only for invalid payloads and legacy failed-task rows.
export const actionQueueResponseSchema = z.array(
  actionQueueItemSchema.catch((ctx) => {
    const raw =
      typeof ctx.input === 'object' && ctx.input !== null
        ? (ctx.input as Record<string, unknown>)
        : {}
    // Re-parse as the generic failed condition; preserves all other base fields
    // a task-failure row accepts. Falls back to a minimal sentinel
    // when even the failed-task variant rejects the row.
    const attempt = taskFailureItemSchema.safeParse({ ...raw, kind: 'failed' })
    if (attempt.success) return attempt.data
    return {
      id: typeof raw.id === 'string' ? raw.id : 'unknown',
      kind: 'failed',
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
      humanSummary: '',
      verbs: [],
      decisions: [],
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
   * task_id). `.catch(null)` tolerates a daemon predating the field.
   */
  arcId: z.string().nullable().catch(null),
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
// Agent tool calls (daemon `/view/agent-tool-calls` → proxied as
// `/api/agent-tool-calls`). Each record is one Claude Code tool invocation
// extracted from the session's `task_transcripts` chunks.
// ----------------------------------------------------------------------------

export const agentToolCallSchema = z.object({
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  resultContent: z.unknown(),
  isError: z.boolean(),
})

export type AgentToolCall = z.infer<typeof agentToolCallSchema>

export const agentToolCallsResponseSchema = z.object({
  calls: z.array(agentToolCallSchema),
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
      const attempt = taskFailureItemSchema.safeParse({ ...raw, kind: 'failed' })
      if (attempt.success) return attempt.data
      return {
        id: typeof raw.id === 'string' ? raw.id : 'unknown',
        kind: 'failed',
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
        humanSummary: '',
        verbs: [],
        decisions: [],
      }
    }),
  ),
  nextCursor: z.string().nullable(),
})

export type ActionQueueHistoryResponse = z.infer<typeof actionQueueHistoryResponseSchema>

export type Decision = z.infer<typeof zDecision>
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
// Purge archive (GET /purge-archive on daemon, proxied as /api/purge-archive)
// ----------------------------------------------------------------------------

export const purgeArchiveEntrySchema = z.object({
  id: z.string(),
  originId: z.string().nullable(),
  branch: z.string().nullable(),
  terminalStatus: z.string(),
  purgedAt: z.string(),
  integratedCommits: z.array(z.string()),
  compensationTaskId: z.string().nullable(),
})

export type PurgeArchiveEntry = z.infer<typeof purgeArchiveEntrySchema>

export const purgeArchiveResponseSchema = z.object({
  rows: z.array(purgeArchiveEntrySchema),
})

// ----------------------------------------------------------------------------
// Chat (GET /api/chat/threads, GET /api/chat/thread/:id, POST /api/chat/threads)
// A chat thread holds an ordered list of messages each composed of typed
// content segments (text / thinking / tool_use) from the Codex CLI.
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
  /** 'pending' while the tool is in-flight; 'complete'/'error' once done; 'proposed' when awaiting operator confirmation. */
  status: z.enum(['pending', 'complete', 'error', 'proposed']).optional().default('complete'),
})

/** Alert action button rendered on the alert card (legacy — prefer alertVerbSchema). */
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
  /**
   * Plain-language headline — replaces the old `title` field.
   * Falls back to empty string for backward-compat with daemon messages that
   * predate the recipe fields.
   */
  humanSummary: z.string().optional().default(''),
  /** Structured detail block for the "Details ▸" expander. */
  humanDetail: alertHumanDetailSchema.optional(),
  /**
   * Ordered, styled verb buttons from the per-kind recipe.
   * Falls back to empty for daemon messages that predate recipe fields.
   */
  verbs: z.array(alertVerbSchema).optional().default([]),
  /** ISO timestamp until which this alert is snoozed. Absent when not snoozed. */
  snoozeUntil: z.string().optional(),
  /**
   * Legacy title field — kept optional so old daemon messages still parse.
   * UI code should prefer humanSummary; use title as the fallback.
   */
  title: z.string().optional().default(''),
  /**
   * Legacy why-now field — kept optional for backward compat.
   * Superseded by humanDetail.
   */
  whyNow: z.string().optional().default(''),
  /** Legacy action buttons — kept optional; prefer verbs. */
  actions: z.array(chatSegmentAlertActionSchema).optional().default([]),
  /** True once the underlying action-queue item has been superseded/resolved. */
  resolved: z.boolean().optional().default(false),
  /**
   * The arc's main goal — "what it was trying to achieve". Present for
   * arc-failed items; absent for other kinds.
   */
  goal: z.string().optional(),
})

/**
 * Result segment: emitted by the Codex runner at the end of a run with usage
 * statistics. Rendered as a subtle footer in the transcript.
 */
export const chatSegmentResultSchema = z.object({
  type: z.literal('result'),
  durationMs: z.number().nullable().optional(),
  inputTokens: z.number().nullable().optional(),
  outputTokens: z.number().nullable().optional(),
  cacheReadTokens: z.number().nullable().optional(),
  cost: z.number().nullable().optional(),
})

/** A safe, durable provider error rendered inside the assistant transcript. */
export const chatSegmentErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
})

/**
 * Tool-result segment: emitted by the daemon alongside tool_use segments to
 * carry the raw tool output back to the client. The transcript renderer
 * attaches it to the matching tool_use (by tool_use_id) in the activity-group
 * rather than rendering it standalone.
 */
export const chatSegmentToolResultSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().optional(),
  content: z.unknown(),
  isError: z.boolean().optional(),
})

/**
 * Attachment segment: a file reference embedded in a user or assistant message.
 * The `path` is relative to `.mars/chat-uploads/` and is served by the UI
 * server's GET `/api/chat/uploads/:path` route.
 */
export const chatSegmentAttachmentSchema = z.object({
  type: z.literal('attachment'),
  /** Server-side path relative to `.mars/chat-uploads/`. */
  path: z.string(),
  mimeType: z.string(),
  name: z.string(),
  /** Renderer hint: 'image', 'audio', or 'video'. */
  kindHint: z.enum(['image', 'audio', 'video']).optional(),
})

const preloadedVerbTargetSchema = z.object({
  type: z.literal('verb'),
  op: z.string(),
  entityId: z.string().optional(),
})

const preloadedSubthreadTargetSchema = z.object({
  type: z.literal('subthread'),
  title: z.string(),
})

const preloadedClientTargetSchema = z.object({
  type: z.literal('client'),
  op: z.literal('open-proposal-subject'),
  entityId: z.string(),
})

export const preloadedResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
  target: z.discriminatedUnion('type', [preloadedVerbTargetSchema, preloadedSubthreadTargetSchema, preloadedClientTargetSchema]),
})

export const preloadedResponsesSegmentSchema = z.object({
  type: z.literal('preloaded_responses'),
  responses: z.array(preloadedResponseSchema),
})

/**
 * A compaction checkpoint written by the idle sweeper. The daemon has produced
 * these since compaction existed, but nothing on this side described them, so
 * the UI dropped them as an unknown segment type and a compacted thread looked
 * identical to one that had simply said less.
 */
export const chatSegmentCompactionSchema = z.object({
  type: z.literal('compaction'),
  summary: z.string(),
  /** Id of the last message this checkpoint covers. */
  coveredThrough: z.string(),
  /** How many messages the checkpoint stands in for, cumulative across checkpoints. */
  messageCount: z.number(),
  taskIds: z.array(z.string()).default([]),
  adrRefs: z.array(z.string()).default([]),
  glossaryRefs: z.array(z.string()).default([]),
  artifactRefs: z.array(z.string()).default([]),
})

export const chatSegmentSchema = z.discriminatedUnion('type', [
  chatSegmentTextSchema,
  chatSegmentCompactionSchema,
  chatSegmentThinkingSchema,
  chatSegmentToolUseSchema,
  chatSegmentAlertSchema,
  chatSegmentResultSchema,
  chatSegmentErrorSchema,
  chatSegmentToolResultSchema,
  chatSegmentAttachmentSchema,
  preloadedResponsesSegmentSchema,
])

export const chatFeedbackSchema = z.object({
  rating: z.enum(['up', 'down']),
  note: z.string().nullable(),
})

export const chatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(['user', 'assistant']),
  /**
   * Segments; defaults to empty array for legacy messages that have no segments.
   * Unknown/future segment types are silently dropped rather than failing the
   * whole message parse — this is the catch/passthrough strategy.
   */
  segments: z
    .array(z.unknown())
    .optional()
    .default([])
    .transform((arr): z.infer<typeof chatSegmentSchema>[] =>
      arr.flatMap(raw => {
        const r = chatSegmentSchema.safeParse(raw)
        return r.success ? [r.data] : []
      })
    ),
  createdAt: z.string(),
  /** Provider input + output tokens spent to produce this turn. */
  turnTokens: z.number().default(0),
  /** Thumbs-up / thumbs-down feedback for assistant messages; null when not rated. */
  feedback: chatFeedbackSchema.nullable().optional().default(null),
})

export const chatThreadSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  /** 'running' while a response is being streamed; 'throttled' during backoff; 'idle' otherwise. */
  status: z.enum(['idle', 'running', 'throttled']),
  /**
   * Derived attention state for sidebar sorting and badging.
   * generating → assistant is actively responding (or retrying)
   * ready      → assistant replied; user hasn't acted yet
   * drafting   → user sent a message but run hasn't started
   * idle       → no pending action
   */
  attentionStatus: z.enum(['generating', 'ready', 'drafting', 'idle']).optional().default('idle'),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().optional().default(0),
  /** 'alert' for proactive alert-origin threads; null for user-created threads. */
  origin: z.string().nullable().optional(),
  /** The action-queue item id this thread tracks; null for non-alert threads. */
  alertItemId: z.string().nullable().optional(),
  /** True when the underlying action-queue item has been resolved. */
  alertResolved: z.boolean().optional().default(false),
  /**
   * Why this Subthread exists, in one sentence, recorded when it was created.
   * Null for Subthreads that predate the objective field — they are never
   * proposed for archival, because there is no stated goal to judge as met.
   */
  objective: z.string().nullable().optional().default(null),
  /** Set once the operator archives the Subthread; null while it stays listed. */
  archivedAt: z.string().nullable().optional().default(null),
  /** Set once the Subthread closes; null while it remains active. */
  closedAt: z.string().nullable().optional().default(null),
  /** Domain event that closes the Subthread automatically, if declared. */
  terminalEventType: z.string().nullable().optional().default(null),
  /** Source thread for a fork, or null for a root conversation. */
  parentThreadId: z.string().nullable().optional().default(null),
})

export const chatThreadsResponseSchema = z.object({
  threads: z.array(chatThreadSchema),
})

export const chatThreadDetailSchema = z.object({
  thread: chatThreadSchema,
  messages: z.array(chatMessageSchema),
})

/** One persisted message in the cross-Subthread conversation projection. */
export const chatConversationEntrySchema = z.object({
  id: z.string(),
  /** Global durable insertion order, used to place the memory boundary. */
  seq: z.number().int().positive(),
  threadId: z.string(),
  subthreadId: z.string(),
  subthreadTitle: z.string(),
  subthreadClosed: z.boolean(),
  role: z.enum(['user', 'assistant']),
  /** Durable plain text used when this message predates typed segments. */
  content: z.string(),
  segments: z.array(z.unknown()).optional().default([]),
  createdAt: z.string(),
  kind: z.enum(['validation', 'acknowledgment', 'situation', 'notice']),
  backingEntityId: z.string().nullable(),
  resolution: z.enum(['resolved']).nullable(),
})

/** Aggregate token weight and lifetime for one Subthread in the conversation. */
export const subthreadBoundarySchema = z.object({
  subthreadId: z.string(),
  startedAt: z.string(),
  closedAt: z.string().nullable(),
  producedTokens: z.number().nonnegative(),
  carriedTokens: z.number().nonnegative(),
})

export const chatConversationResponseSchema = z.object({
  entries: z.array(chatConversationEntrySchema),
  boundaries: z.array(subthreadBoundarySchema).default([]),
  /** Final sequence Mars excludes from its current provider-memory window. */
  memoryStartsAfterSeq: z.number().int().nonnegative(),
  /** Epoch milliseconds when the readable-memory window was last cut. */
  memoryCutAt: z.number().nullable(),
  memoryCutReason: z.enum(['capacity', 'retention-lapse']).nullable(),
})

export type ChatSegmentAlertAction = z.infer<typeof chatSegmentAlertActionSchema>
export type AlertVerb = z.infer<typeof alertVerbSchema>
export type AlertHumanDetail = z.infer<typeof alertHumanDetailSchema>
export type ChatSegmentAlert = z.infer<typeof chatSegmentAlertSchema>
export type ChatSegment = z.infer<typeof chatSegmentSchema>
export type ChatSegmentText = z.infer<typeof chatSegmentTextSchema>
export type ChatSegmentThinking = z.infer<typeof chatSegmentThinkingSchema>
export type ChatSegmentToolUse = z.infer<typeof chatSegmentToolUseSchema>
export type ChatSegmentToolResult = z.infer<typeof chatSegmentToolResultSchema>
export type ChatSegmentAttachment = z.infer<typeof chatSegmentAttachmentSchema>
export type ChatSegmentCompaction = z.infer<typeof chatSegmentCompactionSchema>
export type ChatSegmentResult = z.infer<typeof chatSegmentResultSchema>
export type ChatSegmentError = z.infer<typeof chatSegmentErrorSchema>
export type PreloadedResponse = z.infer<typeof preloadedResponseSchema>
export type PreloadedResponsesSegment = z.infer<typeof preloadedResponsesSegmentSchema>
export type ChatFeedback = z.infer<typeof chatFeedbackSchema>
export type ChatMessage = z.infer<typeof chatMessageSchema>
export type ChatThread = z.infer<typeof chatThreadSchema>
export type ChatThreadsResponse = z.infer<typeof chatThreadsResponseSchema>
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>
export type ChatConversationEntry = z.infer<typeof chatConversationEntrySchema>
export type SubthreadBoundary = z.infer<typeof subthreadBoundarySchema>
export type ChatConversationResponse = z.infer<typeof chatConversationResponseSchema>

// ---------------------------------------------------------------------------
// Chat agent configuration (GET /api/chat/config)
// ---------------------------------------------------------------------------

export const chatConfigToolSchema = z.object({
  name: z.string(),
  description: z.string(),
})

export const chatConfigMcpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  status: z.enum(['connected', 'failed']),
  tools: z.array(chatConfigToolSchema),
})

export const chatConfigSchema = z.object({
  model: z.string(),
  retentionMs: z.number().int().positive(),
  minimumReusablePrefixTokens: z.number().int().positive(),
  contextWindowTokens: z.number().int().positive(),
  systemPrompt: z.string(),
  systemPromptSource: z.enum(['built-in', 'override']),
  builtinTools: z.array(chatConfigToolSchema),
  skills: z.array(chatConfigToolSchema),
  mcpServers: z.array(chatConfigMcpServerSchema),
})

export type ChatConfigTool = z.infer<typeof chatConfigToolSchema>
export type ChatConfigMcpServer = z.infer<typeof chatConfigMcpServerSchema>
export type ChatConfig = z.infer<typeof chatConfigSchema>

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

export const glossaryTermSchema = z.object({
  term: z.string(),
  definition: z.string(),
  avoid: z.array(z.string()),
  surfaceForms: z.array(z.string()).default([]),
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

// ---------------------------------------------------------------------------
// ADRs
// ---------------------------------------------------------------------------

export const adrEntrySchema = z.object({
  number: z.number(),
  title: z.string(),
  slug: z.string(),
})

export const adrsResponseSchema = z.object({
  adrs: z.array(adrEntrySchema),
})

export type AdrEntry = z.infer<typeof adrEntrySchema>

export const projectMetaSchema = z.object({
  vision: z.string().nullable(),
  theme: z.string().nullable(),
})

export type ProjectMeta = z.infer<typeof projectMetaSchema>

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

/**
 * Response for GET /api/vision — returns the raw markdown content of VISION.md
 * for the focused project. `content` is null when VISION.md does not exist.
 */
export const visionResponseSchema = z.object({
  content: z.string().nullable(),
})

export type VisionResponse = z.infer<typeof visionResponseSchema>

// ---------------------------------------------------------------------------
// Learned recipes
// ---------------------------------------------------------------------------

/** One operator-taught auto-run rule (failure signature → op). */
export const learnedRecipeSchema = z.object({
  failureSignature: z.string(),
  actionOp: z.string(),
  learnedAt: z.string(),
})

export const learnedRecipesResponseSchema = z.object({
  ok: z.boolean(),
  learnedRecipes: z.array(learnedRecipeSchema),
})

/** One logged auto-run entry from the `auto_recipe_runs` table. */
export const autoRecipeRunSchema = z.object({
  id: z.string(),
  signature: z.string(),
  actionOp: z.string(),
  taskId: z.string().nullable(),
  ranAt: z.string(),
})

export const autoRecipeRunsResponseSchema = z.object({
  ok: z.boolean(),
  autoRecipeRuns: z.array(autoRecipeRunSchema),
})

export type LearnedRecipe = z.infer<typeof learnedRecipeSchema>
export type AutoRecipeRun = z.infer<typeof autoRecipeRunSchema>

// ── Steward ledger ──────────────────────────────────────────────────────────

/** Immutable record of one proactive Steward intervention. */
export const stewardLedgerEntrySchema = z.object({
  id: z.string(),
  ts: z.string(),
  targetKind: z.string(),
  targetId: z.string(),
  targetVersion: z.string(),
  recipeId: z.string(),
  rationale: z.string(),
  outcome: z.string(),
  commitSha: z.string().nullable(),
})

export const stewardLedgerResponseSchema = z.object({
  ok: z.boolean(),
  entries: z.array(stewardLedgerEntrySchema),
})

export type StewardLedgerEntry = z.infer<typeof stewardLedgerEntrySchema>

// ── While-you-were-away delta ─────────────────────────────────────────────────

/** One activity item returned by GET /view/wywa-delta. */
export const wywaEventSchema = z.object({
  kind: z.enum([
    'merge',
    'failure-recovered',
    'auto-recipe',
    'throttle',
    'evaporated-thread',
  ]),
  /** Plain-English, human-readable description. */
  summary: z.string(),
  /** ISO-8601 timestamp used for newest-first ordering. */
  at: z.string(),
})

export const wywaDeltaResponseSchema = z.object({
  ok: z.boolean(),
  events: z.array(wywaEventSchema),
  /** Count of events truncated beyond the cap. */
  andMore: z.number().int().nonnegative(),
})

export type WywaEvent = z.infer<typeof wywaEventSchema>
export type WywaDeltaResponse = z.infer<typeof wywaDeltaResponseSchema>
