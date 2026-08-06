/**
 * Context lines — what a closed Subject leaves behind in the main thread.
 *
 * A Subject is where the work happens; the main thread is where the operator
 * keeps their bearings. When a Subject ends, its outcome folds back as one
 * line so the feed reads as a continuous account of the day rather than as a
 * list of conversations someone would have to reopen to understand.
 *
 * It is derived, never generated: no provider run, no summarisation. Only
 * facts already in the database — what the Subject was called, and what it
 * actually produced.
 */

import type { DbTx } from './db.js'

export interface ClosedSubjectFacts {
  title: string
  /** Ids of tasks the Subject queued, in the order they were created. */
  taskIds: readonly string[]
  /** True when the Subject was opened from an alert and resolved it. */
  resolvedAlert: boolean
}

const quantity = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`

/**
 * Render the one line a closed Subject contributes.
 *
 * A Subject that produced nothing says so. That is the honest outcome and the
 * useful one — it is exactly the case where the operator, weeks later, wants
 * to know whether they ever acted on something.
 */
export const renderContextLine = (facts: ClosedSubjectFacts): string => {
  const outcomes: string[] = []
  if (facts.taskIds.length > 0) {
    outcomes.push(`queued ${quantity(facts.taskIds.length, 'task', 'tasks')}`)
  }
  if (facts.resolvedAlert) outcomes.push('resolved the alert')
  const outcome = outcomes.length > 0 ? outcomes.join(' and ') : 'queued nothing'
  return `Closed "${facts.title}" — ${outcome}.`
}

/**
 * Read the facts a Context line is built from.
 *
 * Task ids come from the `task_ref` segments the Subject's own messages
 * carry, so this counts work that was really created rather than work that
 * was merely discussed.
 */
export const readClosedSubjectFacts = async (
  c: DbTx,
  threadId: string,
): Promise<ClosedSubjectFacts | null> => {
  const thread = await c.execute({
    sql: 'SELECT title, origin, alert_resolved FROM chat_threads WHERE id = ?',
    args: [threadId],
  })
  const row = thread.rows[0] as
    | { title?: unknown; origin?: unknown; alert_resolved?: unknown }
    | undefined
  if (row === undefined) return null

  const messages = await c.execute({
    sql: 'SELECT segments FROM chat_messages WHERE thread_id = ? ORDER BY seq ASC',
    args: [threadId],
  })
  const taskIds: string[] = []
  for (const message of messages.rows as unknown as { segments?: unknown }[]) {
    if (typeof message.segments !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(message.segments)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    for (const segment of parsed) {
      if (
        typeof segment === 'object' && segment !== null &&
        (segment as { type?: unknown }).type === 'task_ref' &&
        typeof (segment as { taskId?: unknown }).taskId === 'string'
      ) {
        const taskId = (segment as { taskId: string }).taskId
        if (!taskIds.includes(taskId)) taskIds.push(taskId)
      }
    }
  }

  return {
    title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title : 'Untitled Subject',
    taskIds,
    resolvedAlert: row.origin === 'alert' && Boolean(Number(row.alert_resolved ?? 0)),
  }
}
