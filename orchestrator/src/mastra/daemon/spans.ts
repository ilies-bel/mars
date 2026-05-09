import type { SpanRow, SpansKind, SpansResponse } from './protocol'

export const MAX_SPANS_LIMIT = 10_000
export const DEFAULT_SPANS_LIMIT = 5_000

export interface SpansQueryArgs {
  kind: SpansKind
  id: string
  limit?: number
  offset?: number
}

interface DbHandle {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0

const isNonNegativeInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0

export class SpansQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpansQueryError'
  }
}

export const validateSpansArgs = (args: SpansQueryArgs): {
  kind: SpansKind
  id: string
  limit: number
  offset: number
} => {
  if (
    args.kind !== 'by-run' &&
    args.kind !== 'by-task' &&
    args.kind !== 'by-trace'
  ) {
    throw new SpansQueryError(`unknown spans kind: ${String(args.kind)}`)
  }
  if (typeof args.id !== 'string' || args.id.trim().length === 0) {
    throw new SpansQueryError('spans requires a non-empty id')
  }
  let limit = DEFAULT_SPANS_LIMIT
  if (args.limit !== undefined) {
    if (!isPositiveInt(args.limit) || args.limit > MAX_SPANS_LIMIT) {
      throw new SpansQueryError(
        `spans limit must be a positive integer ≤ ${MAX_SPANS_LIMIT}`,
      )
    }
    limit = args.limit
  }
  let offset = 0
  if (args.offset !== undefined) {
    if (!isNonNegativeInt(args.offset)) {
      throw new SpansQueryError('spans offset must be a non-negative integer')
    }
    offset = args.offset
  }
  return { kind: args.kind, id: args.id, limit, offset }
}

const SELECT_COLUMNS = `
  eventType, timestamp, traceId, spanId, parentSpanId, experimentId,
  entityType, entityId, entityName, entityVersionId,
  userId, organizationId, resourceId, runId, sessionId, threadId,
  requestId, environment, source, serviceName, requestContext,
  name, spanType, isEvent, endedAt,
  attributes, metadata, tags, scope, links,
  input, output, error
`

const whereClauseFor = (kind: SpansKind): string => {
  switch (kind) {
    case 'by-run':
      return 'runId = ?'
    case 'by-trace':
      return 'traceId = ?'
    case 'by-task':
      // DuckDB JSON path extraction. attributes is stored as JSON; the
      // orchestrator threads taskId through workflow context, which lands
      // under attributes.taskId at the top level.
      return "json_extract_string(attributes, '$.taskId') = ?"
  }
}

// JSON columns are stored as serialized text; parse them so consumers don't
// have to JSON.parse twice. Tolerate already-parsed values too.
const JSON_COLUMNS: ReadonlyArray<keyof SpanRow> = [
  'requestContext',
  'attributes',
  'metadata',
  'tags',
  'scope',
  'links',
  'input',
  'output',
  'error',
]

const parseJsonColumns = (row: Record<string, unknown>): SpanRow => {
  const out: Record<string, unknown> = { ...row }
  for (const col of JSON_COLUMNS) {
    const v = out[col]
    if (typeof v === 'string' && v.length > 0) {
      try {
        out[col] = JSON.parse(v)
      } catch {
        // Leave non-JSON strings as-is rather than dropping data.
      }
    }
  }
  return out as unknown as SpanRow
}

export const querySpans = async (
  db: DbHandle,
  args: SpansQueryArgs,
): Promise<SpansResponse> => {
  const { kind, id, limit, offset } = validateSpansArgs(args)
  const where = whereClauseFor(kind)

  const countRows = await db.query<{ total: number | bigint }>(
    `SELECT COUNT(*) AS total FROM span_events WHERE ${where}`,
    [id],
  )
  const totalRaw = countRows[0]?.total ?? 0
  const total = typeof totalRaw === 'bigint' ? Number(totalRaw) : Number(totalRaw)

  const rawRows = await db.query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
     FROM span_events
     WHERE ${where}
     ORDER BY timestamp ASC
     LIMIT ? OFFSET ?`,
    [id, limit, offset],
  )

  const rows = rawRows.map(parseJsonColumns)
  const truncated = total > offset + rows.length
  return { rows, total, truncated }
}
