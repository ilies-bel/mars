import { createClient, type Client } from '@libsql/client'

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'done'
  | 'failed'

export type QuestionCategory = 'scope' | 'tech' | 'ux' | 'risk'
export type QuestionStatus = 'open' | 'answered' | 'dismissed'

export interface Question {
  id: string
  taskId: string
  taskPrompt: string
  question: string
  rationale: string | null
  category: QuestionCategory | null
  answer: string | null
  status: QuestionStatus
  createdAt: string
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
    const r = await this.client.execute(
      `SELECT id, prompt, status, plan_functional, plan_technical, branch, worktree_path, claude_session_id, error, created_at, updated_at FROM tasks ORDER BY created_at`,
    )
    return r.rows.map((row) => rowToTask(row as unknown as TaskRow))
  }

  async tableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`,
    )
    return r.rows.length > 0
  }

  async questionsTableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='questions'`,
    )
    return r.rows.length > 0
  }

  async suggestionsTableExists(): Promise<boolean> {
    const r = await this.client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='task_suggestions'`,
    )
    return r.rows.length > 0
  }

  async listQuestions(): Promise<Question[]> {
    const r = await this.client.execute(
      `SELECT q.id, q.task_id, q.question, q.rationale, q.category, q.answer, q.status,
              q.created_at, t.prompt AS task_prompt
       FROM questions q
       LEFT JOIN tasks t ON t.id = q.task_id
       ORDER BY q.task_id, q.created_at`,
    )
    return r.rows.map((row) => {
      const r0 = row as unknown as Record<string, unknown>
      return {
        id: r0.id as string,
        taskId: r0.task_id as string,
        taskPrompt: (r0.task_prompt as string | null) ?? '',
        question: r0.question as string,
        rationale: (r0.rationale as string | null) ?? null,
        category: (r0.category as QuestionCategory | null) ?? null,
        answer: (r0.answer as string | null) ?? null,
        status: r0.status as QuestionStatus,
        createdAt: r0.created_at as string,
      }
    })
  }

  async listSuggestions(): Promise<TaskSuggestion[]> {
    const r = await this.client.execute(
      `SELECT id, source_task_id, title, prompt, rationale, status, created_task_id, created_at
       FROM task_suggestions
       ORDER BY source_task_id, created_at`,
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
