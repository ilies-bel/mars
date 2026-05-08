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

export interface DraftFeature {
  id: string
  goal: string
  story: string
  technical: string
  status: string
  origin: string
  createdAt: number
  updatedAt: number
  acceptanceCount: number
}

export type SuggestionStatus = 'proposed' | 'accepted' | 'dismissed'

export interface TaskSuggestion {
  id: string
  sourceTaskId: string
  title: string
  prompt: string
  rationale: string | null
  status: SuggestionStatus
  createdTaskId: string | null
  createdAt: string
}

export interface TaskRow {
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
  blocker_id: string | null
  blocker_suggestion_id: string | null
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
  blockerSuggestionId: string | null
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
    blockerSuggestionId: row.blocker_suggestion_id ?? row.blocker_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    const hasRetryCount = colNames.has('retry_count')
    const hasBlockerId = colNames.has('blocker_id')

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
      hasBlockerId ? 't.blocker_id' : `NULL AS blocker_id`,
      't.created_at',
      't.updated_at',
    ]

    const sugTableExists = await this.suggestionsTableExists()
    const join =
      hasBlockerId && sugTableExists
        ? `LEFT JOIN task_suggestions s
             ON s.id = t.blocker_id
            AND s.status = 'proposed'`
        : ''
    const blockerCol =
      hasBlockerId && sugTableExists
        ? `s.id AS blocker_suggestion_id`
        : `NULL AS blocker_suggestion_id`
    select.push(blockerCol)

    const sql = `SELECT ${select.join(', ')} FROM tasks t ${join} ORDER BY t.created_at`
    const r = await this.client.execute(sql)
    return r.rows.map((row) => rowToTask(row as unknown as TaskRow))
  }

  async tableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`,
    )
    return r.rows.length > 0
  }

  async suggestionsTableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_suggestions'`,
    )
    return r.rows.length > 0
  }

  async listProposedSuggestions(): Promise<TaskSuggestion[]> {
    const r = await this.client.execute(
      `SELECT id, source_task_id, title, prompt, rationale, status, created_task_id, created_at
       FROM task_suggestions
       WHERE status = 'proposed'
       ORDER BY created_at DESC`,
    )
    return r.rows.map((row) => {
      const r0 = row as unknown as Record<string, unknown>
      return {
        id: r0.id as string,
        sourceTaskId: r0.source_task_id as string,
        title: r0.title as string,
        prompt: r0.prompt as string,
        rationale: (r0.rationale as string | null) ?? null,
        status: r0.status as SuggestionStatus,
        createdTaskId: (r0.created_task_id as string | null) ?? null,
        createdAt: r0.created_at as string,
      }
    })
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

  async ideasTableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='ideas'`,
    )
    return r.rows.length > 0
  }

  async listDraftFeatures(): Promise<DraftFeature[]> {
    const r = await this.client.execute(
      `SELECT i.id, i.goal, i.story, i.technical, i.status, i.origin,
              i.created_at, i.updated_at,
              (SELECT COUNT(*) FROM idea_acceptance a WHERE a.idea_id = i.id) AS acceptance_count
       FROM ideas i
       WHERE i.status = 'draft'
       ORDER BY i.created_at DESC`,
    )
    return r.rows.map((row) => {
      const r0 = row as unknown as Record<string, unknown>
      return {
        id: r0.id as string,
        goal: (r0.goal as string | null) ?? '',
        story: (r0.story as string | null) ?? '',
        technical: (r0.technical as string | null) ?? '',
        status: (r0.status as string | null) ?? 'draft',
        origin: (r0.origin as string | null) ?? 'user',
        createdAt: Number(r0.created_at ?? 0),
        updatedAt: Number(r0.updated_at ?? 0),
        acceptanceCount: Number(r0.acceptance_count ?? 0),
      }
    })
  }
}
