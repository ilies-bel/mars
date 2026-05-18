import { createClient, type Client } from '@libsql/client'

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'done'
  | 'failed'
  | 'dropped'
  | 'blocked'

type ProposalSource = 'reflection' | 'human' | 'planner'

export interface DraftFeature {
  id: string
  goal: string
  story: string
  technical: string
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
  drop_reason: string | null
  retry_count: number | null
  blocker_task_id: string | null
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  prompt: string
  status: TaskStatus
  plan: { functional: string; technical: string } | null
  branch: string | null
  worktreePath: string | null
  error: string | null
  dropReason: string | null
  retryCount: number
  blockerTaskId: string | null
  createdAt: string
  updatedAt: string
}

const rowToTask = (row: TaskRow): Task => {
  const f = row.plan_functional
  const t = row.plan_technical
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    plan: f !== null || t !== null ? { functional: f ?? '', technical: t ?? '' } : null,
    branch: row.branch,
    worktreePath: row.worktree_path,
    error: row.error,
    dropReason: row.drop_reason ?? null,
    retryCount: Number(row.retry_count ?? 0),
    blockerTaskId: row.blocker_task_id ?? null,
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
    const hasRetryCount = colNames.has('retry_count')

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
      hasDropReason ? 't.drop_reason' : `NULL AS drop_reason`,
      hasRetryCount ? 't.retry_count' : `0 AS retry_count`,
      't.created_at',
      't.updated_at',
    ]

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
      `SELECT p.id, p.goal, p.story, p.technical, p.status, p.source,
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
        goal: (r0.goal as string | null) ?? '',
        story: (r0.story as string | null) ?? '',
        technical: (r0.technical as string | null) ?? '',
        status: (r0.status as string | null) ?? 'draft',
        source: normaliseSource(r0.source),
        createdAt: Number(r0.created_at ?? 0),
        updatedAt: Number(r0.updated_at ?? 0),
        acceptanceCount: Number(r0.acceptance_count ?? 0),
      }
    })
  }
}
