import { getClient, initQueue } from '../queue'
import type { UsageTotals } from './claude-usage'

export const isReflectDisabled = (): boolean =>
  process.env.MARS_REFLECT_DISABLED === '1'

export const recordSignals = async (
  taskId: string,
  stepId: string,
  totals: UsageTotals,
): Promise<void> => {
  if (isReflectDisabled()) return
  await initQueue()
  const now = new Date().toISOString()
  await getClient().execute({
    sql: `INSERT INTO task_signals
            (task_id, step_id, input_tokens, output_tokens,
             cache_create_tokens, cache_read_tokens, total_cost_usd,
             message_count, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id, step_id) DO UPDATE SET
            input_tokens        = excluded.input_tokens,
            output_tokens       = excluded.output_tokens,
            cache_create_tokens = excluded.cache_create_tokens,
            cache_read_tokens   = excluded.cache_read_tokens,
            total_cost_usd      = excluded.total_cost_usd,
            message_count       = excluded.message_count,
            recorded_at         = excluded.recorded_at`,
    args: [
      taskId,
      stepId,
      totals.inputTokens,
      totals.outputTokens,
      totals.cacheCreateTokens,
      totals.cacheReadTokens,
      // PRD 1b7498f6: USD cost is dropped at the parser layer. The
      // `total_cost_usd` column is kept for now so existing rows stay
      // readable; a later slice removes the column and this argument.
      0,
      totals.messageCount,
      now,
    ],
  })
}

export interface TaskSignalRow {
  taskId: string
  stepId: string
  inputTokens: number
  outputTokens: number
  cacheCreateTokens: number
  cacheReadTokens: number
  totalCostUsd: number
  messageCount: number
  recordedAt: string
}

export const listTaskSignals = async (taskId: string): Promise<TaskSignalRow[]> => {
  await initQueue()
  const r = await getClient().execute({
    sql: `SELECT task_id, step_id, input_tokens, output_tokens,
                 cache_create_tokens, cache_read_tokens, total_cost_usd,
                 message_count, recorded_at
            FROM task_signals
           WHERE task_id = ?
           ORDER BY recorded_at`,
    args: [taskId],
  })
  return r.rows.map((row) => {
    const r0 = row as unknown as Record<string, unknown>
    return {
      taskId: r0.task_id as string,
      stepId: r0.step_id as string,
      inputTokens: Number(r0.input_tokens ?? 0),
      outputTokens: Number(r0.output_tokens ?? 0),
      cacheCreateTokens: Number(r0.cache_create_tokens ?? 0),
      cacheReadTokens: Number(r0.cache_read_tokens ?? 0),
      totalCostUsd: Number(r0.total_cost_usd ?? 0),
      messageCount: Number(r0.message_count ?? 0),
      recordedAt: r0.recorded_at as string,
    }
  })
}
