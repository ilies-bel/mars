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

type ProposalSource = 'reflection' | 'human' | 'planner'

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
  task_type: string | null
}

export interface TaskSpec {
  files: string[]
  readFirst?: string[]
  prescriptiveAction?: string | null
  verifyCmd: string | null
  doneCriteria: string[]
  taskType: string
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
  const taskType = row.task_type ?? null
  const anySpec =
    filesJson !== null ||
    readFirstJson !== null ||
    prescriptiveAction !== null ||
    verifyCmd !== null ||
    doneCriteriaJson !== null ||
    taskType !== null
  const spec: TaskSpec | null = anySpec
    ? {
        files: parseJsonArray(filesJson),
        readFirst: parseJsonArray(readFirstJson),
        prescriptiveAction,
        verifyCmd,
        doneCriteria: parseJsonArray(doneCriteriaJson),
        taskType: taskType ?? 'auto',
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

const normaliseSource = (raw: unknown): ProposalSource => {
  if (raw === 'reflection' || raw === 'planner' || raw === 'human') return raw
  return 'human'
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
    const hasTaskType = colNames.has('task_type')
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
      hasTaskType ? 't.task_type' : `NULL AS task_type`,
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

  async ensureDismissalsTable(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS stale_worktree_dismissals (
        task_id TEXT PRIMARY KEY,
        dismissed_at INTEGER NOT NULL
      )
    `)
  }

  async dismissStaleWorktree(taskId: string): Promise<void> {
    await this.ensureDismissalsTable()
    await this.client.execute({
      sql: `INSERT OR IGNORE INTO stale_worktree_dismissals (task_id, dismissed_at) VALUES (?, ?)`,
      args: [taskId, Date.now()],
    })
  }

  async listDismissedStaleWorktreeIds(): Promise<Set<string>> {
    try {
      await this.ensureDismissalsTable()
      const r = await this.client.execute(
        `SELECT task_id FROM stale_worktree_dismissals`,
      )
      return new Set(
        r.rows.map((row) => (row as unknown as { task_id: string }).task_id),
      )
    } catch {
      return new Set()
    }
  }

  /**
   * Read operator actionQueue dismissals as a map of `"<entityKind>:<entityId>"` →
   * note. The note encodes the operator action:
   *   - `null`        — dismissed (classic, no note)
   *   - `'dismissed'` — dismissed explicitly
   *   - `'ack'`       — acknowledged; still visible in the open filter
   *   - `'resolved'`  — resolved; hidden from the open filter
   *
   * The derived actionQueue uses this map to compute `dismissed` and `ackState` for
   * each row. Tolerates a missing table (fresh repo) by returning empty.
   */
  async listActionQueueDismissals(): Promise<Map<string, string | null>> {
    try {
      const r = await this.client.execute(
        `SELECT entity_kind, entity_id, note FROM action_queue_dismissals`,
      )
      const out = new Map<string, string | null>()
      for (const row of r.rows) {
        const r0 = row as unknown as {
          entity_kind: string
          entity_id: string
          note: string | null
        }
        out.set(`${r0.entity_kind}:${r0.entity_id}`, r0.note ?? null)
      }
      return out
    } catch {
      return new Map()
    }
  }

  async dismissDraftFeature(id: string): Promise<void> {
    const exists = await this.proposalsTableExists()
    if (!exists) return
    await this.client.execute({
      sql: `UPDATE proposals SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'draft'`,
      args: [Date.now(), id],
    })
  }

  private async ensureActionQueueDismissalsTable(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS action_queue_dismissals (
        entity_kind  TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        dismissed_at TEXT NOT NULL,
        dismissed_by TEXT,
        note         TEXT,
        PRIMARY KEY (entity_kind, entity_id)
      )
    `)
  }

  /**
   * Dismiss an actionQueue row: persist a `(entityKind, entityId)` row so the actionQueue
   * view hides it until the entity's state changes (which clears the dismissal
   * via the orchestrator's `updateTask` hook).
   */
  async dismissActionQueueEntity(
    entityKind: 'task' | 'worktree' | 'proposal',
    entityId: string,
  ): Promise<void> {
    await this.ensureActionQueueDismissalsTable()
    await this.client.execute({
      sql: `INSERT INTO action_queue_dismissals (entity_kind, entity_id, dismissed_at, dismissed_by, note)
            VALUES (?, ?, ?, 'ui', NULL)
            ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
              dismissed_at = excluded.dismissed_at,
              note = excluded.note`,
      args: [entityKind, entityId, new Date().toISOString()],
    })
  }

  /**
   * Acknowledge an actionQueue row: marks it as seen without hiding it from the open
   * filter. Sets `note = 'ack'` so the row remains visible in the default open
   * view but carries an acknowledgement stamp.
   */
  async ackActionQueueEntity(
    entityKind: 'task' | 'worktree' | 'proposal',
    entityId: string,
  ): Promise<void> {
    await this.ensureActionQueueDismissalsTable()
    await this.client.execute({
      sql: `INSERT INTO action_queue_dismissals (entity_kind, entity_id, dismissed_at, dismissed_by, note)
            VALUES (?, ?, ?, 'ui', 'ack')
            ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
              dismissed_at = excluded.dismissed_at,
              note = excluded.note`,
      args: [entityKind, entityId, new Date().toISOString()],
    })
  }

  /**
   * Resolve an actionQueue row: hides it from the open filter and marks it as
   * operator-resolved. Sets `note = 'resolved'`.
   */
  async resolveActionQueueEntity(
    entityKind: 'task' | 'worktree' | 'proposal',
    entityId: string,
  ): Promise<void> {
    await this.ensureActionQueueDismissalsTable()
    await this.client.execute({
      sql: `INSERT INTO action_queue_dismissals (entity_kind, entity_id, dismissed_at, dismissed_by, note)
            VALUES (?, ?, ?, 'ui', 'resolved')
            ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
              dismissed_at = excluded.dismissed_at,
              note = excluded.note`,
      args: [entityKind, entityId, new Date().toISOString()],
    })
  }

  async undismissActionQueueEntity(
    entityKind: 'task' | 'worktree' | 'proposal',
    entityId: string,
  ): Promise<void> {
    await this.ensureActionQueueDismissalsTable()
    await this.client.execute({
      sql: `DELETE FROM action_queue_dismissals WHERE entity_kind = ? AND entity_id = ?`,
      args: [entityKind, entityId],
    })
  }

  /**
   * Read open `stale-worktree` actionQueue items from `action_queue_items` and return them
   * as the same `StaleWorktree` shape the TodoPage already consumes, so the
   * unified model is the single source of truth for the web UI's Alerts section.
   *
   * Falls back to an empty array when the table does not yet exist (fresh repo
   * before any daemon has ever run).
   */
  async listOpenStaleWorktreeAlerts(): Promise<
    Array<{
      taskId: string
      status: string
      ageHours: number
      updatedAt: string
      prompt: string
      error: string | null
      branch: string | null
      blockerTaskId: string | null
    }>
  > {
    try {
      const r = await this.client.execute(
        `SELECT context, payload, last_seen_at, raised_at
           FROM action_queue_items
          WHERE kind = 'stale-worktree' AND state = 'open'
          ORDER BY raised_at DESC`,
      )
      return r.rows.flatMap((row) => {
        const r0 = row as unknown as Record<string, unknown>
        let ctx: Record<string, unknown> = {}
        let pld: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(r0.context as string)
          if (parsed && typeof parsed === 'object') ctx = parsed as Record<string, unknown>
        } catch { /* ignore */ }
        try {
          const parsed = JSON.parse(r0.payload as string)
          if (parsed && typeof parsed === 'object') pld = parsed as Record<string, unknown>
        } catch { /* ignore */ }
        const taskId = typeof ctx.taskId === 'string' ? ctx.taskId : null
        if (!taskId) return []
        return [{
          taskId,
          status: typeof pld.status === 'string' ? pld.status : 'unknown',
          ageHours: typeof pld.ageHours === 'number' ? pld.ageHours : 0,
          updatedAt: typeof r0.last_seen_at === 'string'
            ? r0.last_seen_at
            : (typeof r0.raised_at === 'string' ? r0.raised_at : new Date().toISOString()),
          prompt: typeof pld.prompt === 'string' ? pld.prompt : '',
          error: typeof pld.error === 'string' ? pld.error : null,
          branch: typeof pld.branch === 'string' ? pld.branch : null,
          blockerTaskId: null,
        }]
      })
    } catch {
      // action_queue_items table may not exist yet on a fresh repo.
      return []
    }
  }

  /**
   * Read ALL open actionQueue items from `action_queue_items` and return raw rows for the
   * UI action-queue handler. Cheaper than a derived scan: one bounded SELECT
   * instead of an N-task SQL scan + a .mars/worktrees readdir/stat fan-out.
   *
   * Falls back to an empty array when the table does not yet exist (fresh repo
   * before any daemon has ever run), matching listOpenStaleWorktreeAlerts().
   */
  async listOpenActionQueueItems(): Promise<
    Array<{
      id: string
      kind: string
      priority: string
      title: string
      body: string
      payload: Record<string, unknown>
      context: Record<string, unknown>
      raisedAt: string
      lastSeenAt: string
    }>
  > {
    try {
      const r = await this.client.execute(
        `SELECT id, kind, priority, title, body, payload, context, raised_at, last_seen_at
           FROM action_queue_items
          WHERE state = 'open'
          ORDER BY raised_at DESC`,
      )
      return r.rows.map((row) => {
        const r0 = row as unknown as Record<string, unknown>
        const parseJsonObj = (raw: unknown): Record<string, unknown> => {
          if (typeof raw !== 'string' || !raw) return {}
          try {
            const p = JSON.parse(raw)
            return p && typeof p === 'object' && !Array.isArray(p)
              ? (p as Record<string, unknown>)
              : {}
          } catch {
            return {}
          }
        }
        return {
          id: r0.id as string,
          kind: r0.kind as string,
          priority: r0.priority as string,
          title: r0.title as string,
          body: r0.body as string,
          payload: parseJsonObj(r0.payload),
          context: parseJsonObj(r0.context),
          raisedAt: r0.raised_at as string,
          lastSeenAt:
            (r0.last_seen_at as string | null) ?? (r0.raised_at as string),
        }
      })
    } catch {
      // action_queue_items table may not exist yet on a fresh repo.
      return []
    }
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
