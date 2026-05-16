import { DuckDBConnection } from '@mastra/duckdb'
import {
  deriveTaskKind,
  getClient as getQueueClient,
  initQueue,
  type Task,
  type TaskKind,
} from '../queue'
import { getIdea, type Idea } from '../ideas'
import { resolveContext } from '../context'
import { parseClaudeSessionIds } from './claude-session-ids'

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

let connSingleton: DuckDBConnection | null = null

const getObservabilityConnection = (): DuckDBConnection => {
  if (connSingleton) return connSingleton
  const { observabilityDbPath } = resolveContext()
  connSingleton = new DuckDBConnection({ path: observabilityDbPath })
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
  const fixForTaskId = (row.fix_for_task_id as string | null) ?? null
  const rawKind = (row.kind as string | null) ?? null
  const kind: TaskKind =
    rawKind === 'fix' || rawKind === 'task'
      ? rawKind
      : deriveTaskKind(fixForTaskId)
  return {
    id: row.id as string,
    prompt: String(row.prompt ?? ''),
    status: row.status as Task['status'],
    plan,
    branch: (row.branch as string | null) ?? null,
    worktreePath: (row.worktree_path as string | null) ?? null,
    claudeSessionId: (row.claude_session_id as string | null) ?? null,
    claudeSessionIds: parseClaudeSessionIds(row.claude_session_ids),
    error: (row.error as string | null) ?? null,
    author,
    dropReason: (row.drop_reason as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    retryCount: Number(row.retry_count ?? 0),
    fixForTaskId,
    failureSignature: (row.failure_signature as string | null) ?? null,
    kind,
    originId: ((row.origin_id as string | null) ?? (row.id as string)),
    priority: Number(row.priority ?? 0),
    failedPhase: coerceFailedPhase(row.failed_phase),
    resumeFrom: coerceFailedPhase(row.resume_from),
    spec: null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

const coerceFailedPhase = (raw: unknown): 'code' | 'verify' | 'merge' | null => {
  if (raw === 'code' || raw === 'verify' || raw === 'merge') return raw
  return null
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
  const rows = await conn.query(
    `SELECT traceId, spanId, parentSpanId, name, timestamp, endedAt,
            json_extract_string(metadata, '$.originId') AS origin_meta,
            json_extract_string(error, '$.message') AS error_message
       FROM span_events
      WHERE json_extract_string(metadata, '$.originId') = ?
      ORDER BY timestamp ASC`,
    [originId],
  )
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    traceId: String(row.traceId ?? ''),
    spanId: String(row.spanId ?? ''),
    parentSpanId: (row.parentSpanId as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    stage: stageFromName((row.name as string | null) ?? null),
    startedAt: tsToIso(row.timestamp),
    endedAt: tsToIso(row.endedAt),
    status: row.error_message ? 'error' : 'ok',
    summary: (row.error_message as string | null) ?? null,
  }))
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
