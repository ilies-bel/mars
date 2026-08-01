import { createClient, type Client } from '@libsql/client'

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'vega-reconciling'
  | 'done'
  | 'failed'
  | 'dropped'
  | 'blocked'

/**
 * Server-derived cluster tag for the Progress tab. The UI MUST NOT recompute
 * this — it is the single source of truth for how a live or recently-broken
 * task should be grouped on screen.
 */
export type Cluster = 'Queued' | 'In progress' | 'Blocked' | 'Failed' | 'Done'

export interface ProgressTask extends Task {
  cluster: Cluster
}

type ProposalSource =
  | 'reflection'
  | 'arc-verifier'
  | 'human'
  | 'planner'
  | 'skill-forge'
  | 'failure-reflector'

const PROPOSAL_SOURCES: readonly string[] = [
  'reflection',
  'arc-verifier',
  'human',
  'planner',
  'skill-forge',
  'failure-reflector',
]

/**
 * Minimal proposal representation used as a DAG node in the Topology view.
 * Only proposals with at least one in-scope task are returned.
 */
export interface ProposalNode {
  id: string
  title: string
  source: ProposalSource
  status: string
}

export interface DraftFeature {
  id: string
  title: string
  problem: string
  solution: string
  status: string
  source: ProposalSource
  createdAt: number
  updatedAt: number
  acceptanceCount: number
}

interface TaskRow {
  id: string
  prompt: string
  status: TaskStatus
  plan_functional: string | null
  plan_technical: string | null
  branch: string | null
  worktree_path: string | null
  claude_session_id: string | null
  error: string | null
  failure_signature: string | null
  drop_reason: string | null
  retry_count: number | null
  blocker_task_id: string | null
  blocker_task_ids: string | null
  parent_proposal_id: string | null
  /** Set on recovery/fix tasks; null on the origin task itself. */
  origin_id: string | null
  created_at: string
  updated_at: string
  files_json: string | null
  read_first_json: string | null
  prescriptive_action: string | null
  verify_cmd: string | null
  done_criteria_json: string | null
  merge_mode: string | null
}

export interface TaskSpec {
  files: string[]
  readFirst?: string[]
  prescriptiveAction?: string | null
  verifyCmd: string | null
  doneCriteria: string[]
  mergeMode: string
}

export interface Task {
  id: string
  prompt: string
  status: TaskStatus
  plan: { functional: string; technical: string } | null
  branch: string | null
  worktreePath: string | null
  error: string | null
  /**
   * Machine-readable failure signature stamped at failure time (e.g.
   * `'daemon-killed'`). Drives the error-kind an actionQueue row resolves to — a
   * `daemon-killed` signature surfaces the requeue-framed action menu rather
   * than the generic failed-task menu. Null for non-failed or legacy rows.
   */
  failureSignature: string | null
  dropReason: string | null
  retryCount: number
  blockerTaskId: string | null
  /**
   * Every Task carries the full list of task ids that block it, derived from
   * the `task_blockers` junction. Tasks with no blockers return an empty
   * list, never a missing field. This feeds the Topology tab's DAG view
   * (PRD 82df662a) so the UI can render blocker edges without a second
   * round-trip.
   */
  blockedBy: string[]
  /**
   * The proposal this task was sliced from. Null for ad-hoc tasks.
   * Drives provenance edges in the Topology DAG view.
   */
  parentProposalId: string | null
  /**
   * The origin task id for this arc. Set on recovery/fix tasks; null on the
   * origin task itself (where originId === id). Used by the step timeline to
   * query all spans for the entire task arc via /api/step-spans.
   */
  originId: string | null
  /**
   * Structured-task contract. Null for ad-hoc tasks enqueued without
   * --files/--verify/--done flags or slicer-generated spec.
   */
  spec: TaskSpec | null
  createdAt: string
  updatedAt: string
}

const parseBlockedBy = (raw: string | null): string[] => {
  if (raw === null || raw === '') return []
  return raw.split(',').filter((id) => id.length > 0)
}

const parseJsonArray = (raw: string | null): string[] => {
  if (raw === null || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

const rowToTask = (row: TaskRow): Task => {
  const f = row.plan_functional
  const t = row.plan_technical
  const filesJson = row.files_json ?? null
  const readFirstJson = row.read_first_json ?? null
  const prescriptiveAction = row.prescriptive_action ?? null
  const verifyCmd = row.verify_cmd ?? null
  const doneCriteriaJson = row.done_criteria_json ?? null
  const mergeMode = row.merge_mode ?? null
  const anySpec =
    filesJson !== null ||
    readFirstJson !== null ||
    prescriptiveAction !== null ||
    verifyCmd !== null ||
    doneCriteriaJson !== null ||
    mergeMode !== null
  const spec: TaskSpec | null = anySpec
    ? {
        files: parseJsonArray(filesJson),
        readFirst: parseJsonArray(readFirstJson),
        prescriptiveAction,
        verifyCmd,
        doneCriteria: parseJsonArray(doneCriteriaJson),
        mergeMode: mergeMode ?? 'auto',
      }
    : null
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    plan: f !== null || t !== null ? { functional: f ?? '', technical: t ?? '' } : null,
    branch: row.branch,
    worktreePath: row.worktree_path,
    error: row.error,
    failureSignature: row.failure_signature ?? null,
    dropReason: row.drop_reason ?? null,
    retryCount: Number(row.retry_count ?? 0),
    blockerTaskId: row.blocker_task_id ?? null,
    blockedBy: parseBlockedBy(row.blocker_task_ids ?? null),
    parentProposalId: row.parent_proposal_id ?? null,
    originId: row.origin_id ?? null,
    spec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const normaliseSource = (raw: unknown): ProposalSource =>
  typeof raw === 'string' && PROPOSAL_SOURCES.includes(raw)
    ? (raw as ProposalSource)
    : 'human'

/**
 * Maps a task to its Progress-tab cluster, or `null` if the task is out of
 * scope (draft/dropped). Done tasks are included as arc metadata with cluster
 * 'Done'. All failed tasks are always in scope — there is no recency gate on
 * the Failed cluster.
 */
const clusterFor = (task: Task): Cluster | null => {
  switch (task.status) {
    case 'queued':
      return 'Queued'
    case 'running':
    case 'verifying':
    case 'merging':
    case 'vega-reconciling':
      return 'In progress'
    case 'blocked':
      return 'Blocked'
    case 'failed':
      return 'Failed'
    case 'done':
      return 'Done'
    case 'draft':
    case 'dropped':
      return null
  }
}

export class TaskDb {
  private client: Client

  constructor(dbPath: string) {
    this.client = createClient({ url: `file:${dbPath}` })
  }

  async init(): Promise<void> {
    await this.client.execute(`PRAGMA journal_mode = WAL`)
  }

  async listTasks(): Promise<Task[]> {
    const cols = await this.client.execute(`PRAGMA table_info(tasks)`)
    const colNames = new Set(
      cols.rows.map((r) => (r as unknown as { name: string }).name),
    )
    const hasDropReason = colNames.has('drop_reason')
    const hasFailureSignature = colNames.has('failure_signature')
    const hasRetryCount = colNames.has('retry_count')
    const hasFilesJson = colNames.has('files_json')
    const hasReadFirstJson = colNames.has('read_first_json')
    const hasPrescriptiveAction = colNames.has('prescriptive_action')
    const hasVerifyCmd = colNames.has('verify_cmd')
    const hasDoneCriteriaJson = colNames.has('done_criteria_json')
    const hasMergeMode = colNames.has('merge_mode')
    const hasParentProposalId = colNames.has('parent_proposal_id')
    const hasOriginId = colNames.has('origin_id')

    const select: string[] = [
      't.id',
      't.prompt',
      't.status',
      't.plan_functional',
      't.plan_technical',
      't.branch',
      't.worktree_path',
      't.claude_session_id',
      't.error',
      hasFailureSignature ? 't.failure_signature' : `NULL AS failure_signature`,
      hasDropReason ? 't.drop_reason' : `NULL AS drop_reason`,
      hasRetryCount ? 't.retry_count' : `0 AS retry_count`,
      't.created_at',
      't.updated_at',
      hasFilesJson ? 't.files_json' : `NULL AS files_json`,
      hasReadFirstJson ? 't.read_first_json' : `NULL AS read_first_json`,
      hasPrescriptiveAction ? 't.prescriptive_action' : `NULL AS prescriptive_action`,
      hasVerifyCmd ? 't.verify_cmd' : `NULL AS verify_cmd`,
      hasDoneCriteriaJson ? 't.done_criteria_json' : `NULL AS done_criteria_json`,
      hasMergeMode ? 't.merge_mode' : `NULL AS merge_mode`,
    ]

    select.push(hasParentProposalId ? 't.parent_proposal_id' : 'NULL AS parent_proposal_id')
    select.push(hasOriginId ? 't.origin_id' : 'NULL AS origin_id')

    const blockersTableExists = await this.blockersTableExists()
    // For blocked tasks, surface the first blocker task id (if any) so the
    // UI can show a "blocked by" link. The composite junction can hold many
    // edges, but the card only renders one.
    const blockerCol = blockersTableExists
      ? `(SELECT b.blocker_task_id
            FROM task_blockers b
           WHERE b.task_id = t.id
        ORDER BY b.created_at ASC
           LIMIT 1) AS blocker_task_id`
      : `NULL AS blocker_task_id`
    select.push(blockerCol)
    // PRD 82df662a / slice 1: every task carries the full list of its
    // blocker ids (as a comma-joined string, parsed back to string[] in
    // `rowToTask`). Tasks with no blockers get an empty string -> [].
    const blockerIdsCol = blockersTableExists
      ? `(SELECT GROUP_CONCAT(b.blocker_task_id, ',')
            FROM (SELECT blocker_task_id, created_at FROM task_blockers
                   WHERE task_id = t.id
                ORDER BY created_at ASC) b) AS blocker_task_ids`
      : `NULL AS blocker_task_ids`
    select.push(blockerIdsCol)

    const sql = `SELECT ${select.join(', ')} FROM tasks t ORDER BY t.created_at`
    const r = await this.client.execute(sql)
    return r.rows.map((row) => rowToTask(row as unknown as TaskRow))
  }

  async listTasksByStatus(statuses: TaskStatus[]): Promise<Task[]> {
    if (statuses.length === 0) return []
    const all = await this.listTasks()
    const wanted = new Set<TaskStatus>(statuses)
    return all.filter((t) => wanted.has(t.status))
  }

  /**
   * Tasks in scope for the Progress tab.
   *
   * Scope:
   * - all non-terminal statuses (queued, running, verifying, merging, blocked)
   * - all `failed` tasks regardless of age
   *
   * Excluded:
   * - `draft` (not yet enqueued)
   * - `done` and `dropped` (terminal-success or operator-dismissed)
   *
   * Each returned task carries a server-derived `cluster` tag so the UI
   * does not encode the cluster taxonomy itself.
   */
  async listProgressTasks(): Promise<ProgressTask[]> {
    const exists = await this.tableExists()
    if (!exists) return []
    const all = await this.listTasks()
    const out: ProgressTask[] = []
    for (const t of all) {
      const cluster = clusterFor(t)
      if (cluster === null) continue
      out.push({ ...t, cluster })
    }
    return out
  }

  async findTaskById(id: string): Promise<Task | null> {
    const exists = await this.tableExists()
    if (!exists) return null
    const all = await this.listTasks()
    return all.find((t) => t.id === id) ?? null
  }

  async tableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`,
    )
    return r.rows.length > 0
  }

  async blockersTableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_blockers'`,
    )
    return r.rows.length > 0
  }
}

export class StateDb {
  private client: Client

  constructor(dbPath: string) {
    this.client = createClient({ url: `file:${dbPath}` })
  }

  async init(): Promise<void> {
    await this.client.execute(`PRAGMA journal_mode = WAL`)
  }

  async proposalsTableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'`,
    )
    return r.rows.length > 0
  }

  async dismissDraftFeature(id: string): Promise<void> {
    const exists = await this.proposalsTableExists()
    if (!exists) return
    await this.client.execute({
      sql: `UPDATE proposals SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'draft'`,
      args: [Date.now(), id],
    })
  }

  async listDraftFeatures(): Promise<DraftFeature[]> {
    const r = await this.client.execute(
      `SELECT p.id, p.title, p.problem, p.solution, p.status, p.source,
              p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM proposal_user_stories s WHERE s.proposal_id = p.id) AS acceptance_count
       FROM proposals p
       WHERE p.status = 'draft'
       ORDER BY p.created_at DESC`,
    )
    return r.rows.map((row) => {
      const r0 = row as unknown as Record<string, unknown>
      return {
        id: r0.id as string,
        title: (r0.title as string | null) ?? '',
        problem: (r0.problem as string | null) ?? '',
        solution: (r0.solution as string | null) ?? '',
        status: (r0.status as string | null) ?? 'draft',
        source: normaliseSource(r0.source),
        createdAt: Number(r0.created_at ?? 0),
        updatedAt: Number(r0.updated_at ?? 0),
        acceptanceCount: Number(r0.acceptance_count ?? 0),
      }
    })
  }

  /**
   * Returns ProposalNode data for each of the given proposal IDs.
   * IDs not found in the proposals table are silently omitted.
   * Falls back to an empty array when the proposals table does not exist.
   */
  async listProposalsByIds(ids: string[]): Promise<ProposalNode[]> {
    if (ids.length === 0) return []
    const exists = await this.proposalsTableExists()
    if (!exists) return []
    const placeholders = ids.map(() => '?').join(', ')
    const r = await this.client.execute({
      sql: `SELECT id, title, status, source
              FROM proposals
             WHERE id IN (${placeholders})`,
      args: ids,
    })
    return r.rows.map((row) => {
      const r0 = row as unknown as Record<string, unknown>
      return {
        id: r0.id as string,
        title: (r0.title as string | null) ?? '',
        status: (r0.status as string | null) ?? 'draft',
        source: normaliseSource(r0.source),
      }
    })
  }
}
