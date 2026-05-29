import { getClient, initQueue } from '../queue'

export interface OriginTaskSummary {
  taskId: string
  status: string
  kind: string
  createdAt: string
  error: string | null
  promptPreview: string
  hasVerifyOutput: boolean
}

export interface OriginTimeline {
  originId: string
  tasks: OriginTaskSummary[]
  spanCount: number
  /** Tasks whose fix_for_task_id IS NOT NULL (recovery/fix tasks). */
  retryCount: number
  /** Tasks that have a non-empty verify_output in their transcript. */
  verifyFailureCount: number
}

/** Score an origin for auto-pick. Higher = more interesting to reflect on. */
export const scoreOriginTimeline = (
  t: Pick<OriginTimeline, 'spanCount' | 'retryCount' | 'verifyFailureCount'>,
): number => t.spanCount + t.retryCount + t.verifyFailureCount

/** Format an origin timeline as a human-readable string for prompt inclusion. */
export const formatOriginTimeline = (timeline: OriginTimeline): string => {
  const header = `Origin arc ${timeline.originId}: ${timeline.spanCount} task(s), ${timeline.retryCount} retries, ${timeline.verifyFailureCount} verify failure(s)`
  const rows = timeline.tasks.map((t, i) => {
    const verifyFlag = t.hasVerifyOutput ? ' [verify-failed]' : ''
    const errorSnippet = t.error ? ` error="${t.error.slice(0, 80)}"` : ''
    return `  [${i + 1}] ${t.taskId} status=${t.status} kind=${t.kind} createdAt=${t.createdAt}${errorSnippet}${verifyFlag}\n       prompt: ${t.promptPreview}`
  })
  return [header, ...rows].join('\n')
}

interface OriginTaskRow {
  id: string
  status: string
  prompt: string
  error: string | null
  created_at: string
  kind: string | null
  fix_for_task_id: string | null
  has_verify_output: number
}

/** Load the full origin timeline for the given originId from the queue DB. */
export const loadOriginTimeline = async (
  originId: string,
): Promise<OriginTimeline | null> => {
  await initQueue()
  const c = getClient()
  // After PRD 436f14c7 slice 5, verify output lives in trace_events.
  // A correlated EXISTS subquery avoids JOIN-multiplication when a task has
  // multiple step_ended events.
  const r = await c.execute({
    sql: `
      SELECT t.id, t.status, t.prompt, t.error, t.created_at, t.kind, t.fix_for_task_id,
             CASE WHEN EXISTS (
               SELECT 1 FROM trace_events te
               WHERE te.task_id = t.id AND te.kind = 'step_ended'
                 AND json_extract(te.payload, '$.verifyOutput') IS NOT NULL
                 AND json_extract(te.payload, '$.verifyOutput') != ''
             ) THEN 1 ELSE 0 END AS has_verify_output
        FROM tasks t
       WHERE COALESCE(t.origin_id, t.id) = ?
       ORDER BY t.created_at ASC`,
    args: [originId],
  })
  if (r.rows.length === 0) return null

  const tasks: OriginTaskSummary[] = r.rows.map((row) => {
    const r0 = row as unknown as OriginTaskRow
    const kind = r0.kind ?? (r0.fix_for_task_id ? 'fix' : 'task')
    return {
      taskId: r0.id,
      status: r0.status,
      kind,
      createdAt: r0.created_at,
      error: r0.error ?? null,
      promptPreview: String(r0.prompt ?? '').slice(0, 200),
      hasVerifyOutput: Number(r0.has_verify_output) === 1,
    }
  })

  const spanCount = tasks.length
  const retryCount = tasks.filter((t) => t.kind === 'fix').length
  const verifyFailureCount = tasks.filter((t) => t.hasVerifyOutput).length

  return { originId, tasks, spanCount, retryCount, verifyFailureCount }
}

interface PickOriginRow {
  origin_id: string
  span_count: number
  retry_count: number
  verify_failure_count: number
  last_activity: string
}

/**
 * Auto-pick the origin to reflect on, scored by
 * span_count + retry_count + verify_failure_count.
 * Tie-break: most recent last_activity (ISO string, lexicographic — deterministic).
 */
export const pickTopOrigin = async (): Promise<{
  originId: string
  score: number
} | null> => {
  await initQueue()
  const c = getClient()
  // After PRD 436f14c7 slice 5, verify output lives in trace_events.
  // A correlated EXISTS subquery avoids JOIN-multiplication per task.
  const r = await c.execute(`
    SELECT
      COALESCE(t.origin_id, t.id) AS origin_id,
      COUNT(*) AS span_count,
      SUM(CASE WHEN t.fix_for_task_id IS NOT NULL THEN 1 ELSE 0 END) AS retry_count,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM trace_events te
        WHERE te.task_id = t.id AND te.kind = 'step_ended'
          AND json_extract(te.payload, '$.verifyOutput') IS NOT NULL
          AND json_extract(te.payload, '$.verifyOutput') != ''
      ) THEN 1 ELSE 0 END) AS verify_failure_count,
      MAX(COALESCE(t.updated_at, t.created_at)) AS last_activity
    FROM tasks t
    WHERE t.status IN ('done', 'failed')
    GROUP BY COALESCE(t.origin_id, t.id)
  `)

  if (r.rows.length === 0) return null

  const rows: PickOriginRow[] = r.rows.map((row) => {
    const r0 = row as unknown as Record<string, unknown>
    return {
      origin_id: r0.origin_id as string,
      span_count: Number(r0.span_count ?? 0),
      retry_count: Number(r0.retry_count ?? 0),
      verify_failure_count: Number(r0.verify_failure_count ?? 0),
      last_activity: (r0.last_activity as string | null) ?? '',
    }
  })

  rows.sort((a, b) => {
    const scoreA = a.span_count + a.retry_count + a.verify_failure_count
    const scoreB = b.span_count + b.retry_count + b.verify_failure_count
    if (scoreB !== scoreA) return scoreB - scoreA
    // Tie-break: most recent last_activity wins (ISO strings sort lexicographically)
    return b.last_activity.localeCompare(a.last_activity)
  })

  const top = rows[0]
  if (!top) return null
  return {
    originId: top.origin_id,
    score: top.span_count + top.retry_count + top.verify_failure_count,
  }
}
