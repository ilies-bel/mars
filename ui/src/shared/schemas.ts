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

const taskSchema = z.object({
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

export const actionQueueItemSchema = z.object({
  id: z.string(),
  // unknown kinds coerce to 'failed-task' to mirror server toUiKind and keep
  // one bad row (e.g. a stale persisted kind) from failing the whole response.
  // .catch() intentionally swallows any non-member value into the default —
  // for a closed enum this is the desired safe behaviour, not a masked bug.
  kind: z.enum([
    'failed-task',
    'stale-worktree',
    'draft-proposal',
  ]).catch('failed-task'),
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
   * Populated only for stale-worktree rows; null for all other kinds.
   * Carries the originating task context and a git-derived emptiness flag
   * so the UI can decide which action buttons to show (prune-only vs
   * prune + investigate).
   */
  staleWorktreeDetail: z.object({
    /** Task prompt, or null when no matching task row exists. */
    prompt: z.string().nullable(),
    /** Task status string, or 'unknown' when the task row is absent. */
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
  }).nullish(),
  /**
   * Root-cause diagnosis written by the diagnose-failure action, or null when
   * none has been run. Only populated for unknown-signature failed-task rows.
   */
  diagnosis: z
    .object({
      text: z.string(),
      diagnosedAt: z.string(),
    })
    .nullish(),
})

export const actionQueueResponseSchema = z.array(actionQueueItemSchema)

export const agentSchema = z.object({
  name: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  permissionMode: z.string().nullable(),
  allowedTools: z.array(z.string()),
  deniedTools: z.array(z.string()),
  messageCap: z.number().nullable(),
  role: z.string(),
})

export const agentsResponseSchema = z.object({
  agents: z.array(agentSchema),
})

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
export type Agent = z.infer<typeof agentSchema>
