import { enqueueTask, getClient, initQueue } from './queue'

export interface SuggestionRow {
  id: string
  sourceTaskId: string
  title: string
  prompt: string
  rationale: string | null
  status: string
  createdTaskId: string | null
  createdAt: string
}

const rowToSuggestion = (row: Record<string, unknown>): SuggestionRow => ({
  id: row.id as string,
  sourceTaskId: row.source_task_id as string,
  title: row.title as string,
  prompt: row.prompt as string,
  rationale: (row.rationale as string | null) ?? null,
  status: row.status as string,
  createdTaskId: (row.created_task_id as string | null) ?? null,
  createdAt: row.created_at as string,
})

export const listSuggestions = async (status?: string): Promise<SuggestionRow[]> => {
  await initQueue()
  const r = status
    ? await getClient().execute({
        sql: `SELECT * FROM task_suggestions WHERE status = ? ORDER BY created_at DESC`,
        args: [status],
      })
    : await getClient().execute(
        `SELECT * FROM task_suggestions ORDER BY created_at DESC`,
      )
  return r.rows.map((row) => rowToSuggestion(row as unknown as Record<string, unknown>))
}

export const getSuggestion = async (id: string): Promise<SuggestionRow | null> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT * FROM task_suggestions WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  return rowToSuggestion(r.rows[0] as unknown as Record<string, unknown>)
}

export interface PromoteResult {
  taskId: string
}

export const promoteSuggestion = async (id: string): Promise<PromoteResult | null> => {
  await initQueue()
  const suggestion = await getSuggestion(id)
  if (!suggestion) return null
  if (
    (suggestion.status === 'accepted' || suggestion.status === 'promoted') &&
    suggestion.createdTaskId
  ) {
    return null
  }

  const task = await enqueueTask(suggestion.prompt)
  await getClient().execute({
    sql: `UPDATE task_suggestions SET status = 'promoted', created_task_id = ? WHERE id = ?`,
    args: [task.id, id],
  })
  return { taskId: task.id }
}
