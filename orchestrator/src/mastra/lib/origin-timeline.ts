import { createClient, type Client } from '@libsql/client'
import { getClient as getQueueClient, initQueue, type Task } from '../queue'
import { getIdea, type Idea } from '../ideas'
import { resolveContext } from '../context'

export interface OriginTimelineSpan {
  traceId: string
  spanId: string
  parentSpanId: string | null
  name: string | null
  stage: string | null
  startedAt: string | null
  endedAt: string | null
  status: string | null
  summary: string | null
}

export interface OriginTimeline {
  origin: { kind: 'idea' | 'task'; id: string; row: Idea | Task | null }
  tasks: Task[]
  spans: OriginTimelineSpan[]
}

let connSingleton: Client | null = null

const getObservabilityConnection = (): Client => {
  if (connSingleton) return connSingleton
  const { observabilityDbPath } = resolveContext()
  connSingleton = createClient({ url: `file:${observabilityDbPath}` })
  return connSingleton
}

const rowToTask = (row: Record<string, unknown>): Task => {
  const functional = (row.plan_functional as string | null) ?? null
  const technical = (row.plan_technical as string | null) ?? null
  const plan =
    functional !== null || technical !== null
      ? { functional: functional ?? '', technical: technical ?? '' }
      : null
  const authorKindRaw = (row.author_kind as string | null) ?? null
  const authorName = (row.author_name as string | null) ?? null
  const author =
    authorKindRaw === 'human' || authorKindRaw === 'agent'
      ? { kind: authorKindRaw as 'human' | 'agent', name: authorName ?? 'unknown' }
      : null
  return {
    id: row.id as string,
    prompt: String(row.prompt ?? ''),
    status: row.status as Task['status'],
    plan,
    branch: (row.branch as string | null) ?? null,
    worktreePath: (row.worktree_path as string | null) ?? null,
    claudeSessionId: (row.claude_session_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    author,
    dropReason: (row.drop_reason as string | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    fixForTaskId: (row.fix_for_task_id as string | null) ?? null,
    failureSignature: (row.failure_signature as string | null) ?? null,
    originId: ((row.origin_id as string | null) ?? (row.id as string)),
    priority: Number(row.priority ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

const loadTasksByOrigin = async (originId: string): Promise<Task[]> => {
  await initQueue()
  const r = await getQueueClient().execute({
    sql: `SELECT * FROM tasks WHERE origin_id = ? ORDER BY created_at ASC`,
    args: [originId],
  })
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>))
}

const stageFromName = (name: string | null): string | null => {
  if (!name) return null
  const lower = name.toLowerCase()
  if (lower.includes('plan')) return 'plan'
  if (lower.includes('triage')) return 'triage'
  if (lower.includes('verify')) return 'verify'
  if (lower.includes('merge')) return 'merge'
  if (lower.includes('claude') || lower.includes('code')) return 'implement'
  if (lower.includes('setup')) return 'implement'
  if (lower.includes('scorer')) return 'scorer'
  return null
}

const tsToIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value === 'bigint') return new Date(Number(value)).toISOString()
  return String(value)
}

const loadSpans = async (originId: string): Promise<OriginTimelineSpan[]> => {
  const conn = getObservabilityConnection()
  // Mastra's LibSQL observability adapter writes spans to mastra_ai_spans
  // (see @mastra/core SPAN_SCHEMA). SQLite uses json_extract — DuckDB's
  // json_extract_string is not available here.
  const r = await conn.execute({
    sql: `SELECT traceId, spanId, parentSpanId, name, startedAt, endedAt,
                 json_extract(error, '$.message') AS error_message
            FROM mastra_ai_spans
           WHERE json_extract(metadata, '$.originId') = ?
           ORDER BY startedAt ASC`,
    args: [originId],
  })
  return r.rows.map((row) => {
    const r = row as unknown as Record<string, unknown>
    return {
      traceId: String(r.traceId ?? ''),
      spanId: String(r.spanId ?? ''),
      parentSpanId: (r.parentSpanId as string | null) ?? null,
      name: (r.name as string | null) ?? null,
      stage: stageFromName((r.name as string | null) ?? null),
      startedAt: tsToIso(r.startedAt),
      endedAt: tsToIso(r.endedAt),
      status: r.error_message ? 'error' : 'ok',
      summary: (r.error_message as string | null) ?? null,
    }
  })
}

export const loadOriginTimeline = async (
  originId: string,
): Promise<OriginTimeline> => {
  const [idea, tasks, spans] = await Promise.all([
    getIdea(originId).catch(() => null),
    loadTasksByOrigin(originId),
    loadSpans(originId),
  ])

  let origin: OriginTimeline['origin']
  if (idea) {
    origin = { kind: 'idea', id: originId, row: idea }
  } else {
    const selfTask = tasks.find((t) => t.id === originId) ?? null
    origin = { kind: 'task', id: originId, row: selfTask }
  }

  return { origin, tasks, spans }
}
