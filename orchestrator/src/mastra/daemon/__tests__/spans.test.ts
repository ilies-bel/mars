import { describe, expect, it } from 'vitest'
import { querySpans, SpansQueryError, validateSpansArgs } from '../spans'

interface FakeRow {
  spanId: string
  traceId: string
  runId: string
  attributes: string // JSON-encoded, like DuckDB returns
  timestamp: string
  output: string
}

const baseColumns = {
  eventType: 'span',
  parentSpanId: null,
  experimentId: null,
  entityType: null,
  entityId: null,
  entityName: null,
  entityVersionId: null,
  userId: null,
  organizationId: null,
  resourceId: null,
  sessionId: null,
  threadId: null,
  requestId: null,
  environment: null,
  source: null,
  serviceName: null,
  requestContext: null,
  name: 'test',
  spanType: null,
  isEvent: false,
  endedAt: null,
  metadata: null,
  tags: null,
  scope: null,
  links: null,
  input: null,
  error: null,
}

const makeFakeDb = (rows: FakeRow[]) => {
  let lastSql = ''
  let lastParams: unknown[] = []
  return {
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      lastSql = sql
      lastParams = params
      const lower = sql.toLowerCase()
      // The where clause ends in `= ?` and id is the first param.
      const id = params[0] as string
      let filter: (r: FakeRow) => boolean
      if (lower.includes('runid =')) {
        filter = (r) => r.runId === id
      } else if (lower.includes('traceid =')) {
        filter = (r) => r.traceId === id
      } else if (lower.includes("json_extract_string(attributes, '$.taskid')")) {
        filter = (r) => {
          try {
            return (JSON.parse(r.attributes) as { taskId?: string }).taskId === id
          } catch {
            return false
          }
        }
      } else {
        filter = () => false
      }
      const matched = rows.filter(filter)
      if (lower.startsWith('select count')) {
        return [{ total: matched.length }] as unknown as T[]
      }
      const limit = Number(params[1] ?? matched.length)
      const offset = Number(params[2] ?? 0)
      const sliced = matched.slice(offset, offset + limit)
      return sliced.map((r) => ({ ...baseColumns, ...r })) as unknown as T[]
    },
    inspect: () => ({ lastSql, lastParams }),
  }
}

const span = (overrides: Partial<FakeRow>): FakeRow => ({
  spanId: 's1',
  traceId: 't1',
  runId: 'r1',
  attributes: JSON.stringify({ taskId: 'task-x' }),
  timestamp: '2026-01-01T00:00:00Z',
  output: JSON.stringify({ ok: true }),
  ...overrides,
})

describe('validateSpansArgs', () => {
  it('rejects unknown kind', () => {
    expect(() =>
      validateSpansArgs({ kind: 'by-cow' as never, id: 'x' }),
    ).toThrow(SpansQueryError)
  })

  it('rejects empty id', () => {
    expect(() => validateSpansArgs({ kind: 'by-run', id: '   ' })).toThrow(
      SpansQueryError,
    )
  })

  it('rejects oversized limit', () => {
    expect(() =>
      validateSpansArgs({ kind: 'by-run', id: 'x', limit: 1_000_000 }),
    ).toThrow(SpansQueryError)
  })

  it('rejects negative offset', () => {
    expect(() =>
      validateSpansArgs({ kind: 'by-run', id: 'x', offset: -1 }),
    ).toThrow(SpansQueryError)
  })

  it('returns defaults when limit/offset missing', () => {
    const r = validateSpansArgs({ kind: 'by-run', id: 'x' })
    expect(r.limit).toBe(5_000)
    expect(r.offset).toBe(0)
  })
})

describe('querySpans', () => {
  it('by-run filters on runId', async () => {
    const rows = [
      span({ spanId: 'a', runId: 'run-1' }),
      span({ spanId: 'b', runId: 'run-2' }),
      span({ spanId: 'c', runId: 'run-1' }),
    ]
    const db = makeFakeDb(rows)
    const res = await querySpans(db, { kind: 'by-run', id: 'run-1' })
    expect(res.total).toBe(2)
    expect(res.rows.map((r) => r.spanId)).toEqual(['a', 'c'])
    expect(res.truncated).toBe(false)
  })

  it('by-trace filters on traceId', async () => {
    const rows = [
      span({ spanId: 'a', traceId: 'trace-1' }),
      span({ spanId: 'b', traceId: 'trace-2' }),
    ]
    const db = makeFakeDb(rows)
    const res = await querySpans(db, { kind: 'by-trace', id: 'trace-2' })
    expect(res.total).toBe(1)
    expect(res.rows[0]?.spanId).toBe('b')
  })

  it('by-task filters via attributes JSON path', async () => {
    const rows = [
      span({ spanId: 'a', attributes: JSON.stringify({ taskId: 'task-1' }) }),
      span({ spanId: 'b', attributes: JSON.stringify({ taskId: 'task-2' }) }),
      span({ spanId: 'c', attributes: JSON.stringify({ taskId: 'task-1', other: 'x' }) }),
    ]
    const db = makeFakeDb(rows)
    const res = await querySpans(db, { kind: 'by-task', id: 'task-1' })
    expect(res.total).toBe(2)
    expect(res.rows.map((r) => r.spanId)).toEqual(['a', 'c'])
  })

  it('parses JSON columns into structured values', async () => {
    const rows = [
      span({
        spanId: 'a',
        attributes: JSON.stringify({ taskId: 'task-1', nested: { k: 'v' } }),
        output: JSON.stringify({ ok: true, n: 42 }),
      }),
    ]
    const db = makeFakeDb(rows)
    const res = await querySpans(db, { kind: 'by-task', id: 'task-1' })
    expect(res.rows[0]?.attributes).toEqual({
      taskId: 'task-1',
      nested: { k: 'v' },
    })
    expect(res.rows[0]?.output).toEqual({ ok: true, n: 42 })
  })

  it('sets truncated when total > limit + offset', async () => {
    const rows = [
      span({ spanId: 'a', runId: 'run-1' }),
      span({ spanId: 'b', runId: 'run-1' }),
      span({ spanId: 'c', runId: 'run-1' }),
    ]
    const db = makeFakeDb(rows)
    const res = await querySpans(db, {
      kind: 'by-run',
      id: 'run-1',
      limit: 2,
      offset: 0,
    })
    expect(res.total).toBe(3)
    expect(res.rows).toHaveLength(2)
    expect(res.truncated).toBe(true)
  })

  it('does not set truncated when offset+rows reach total', async () => {
    const rows = [
      span({ spanId: 'a', runId: 'run-1' }),
      span({ spanId: 'b', runId: 'run-1' }),
    ]
    const db = makeFakeDb(rows)
    const res = await querySpans(db, {
      kind: 'by-run',
      id: 'run-1',
      limit: 5,
    })
    expect(res.total).toBe(2)
    expect(res.truncated).toBe(false)
  })

  it('propagates validation errors as SpansQueryError', async () => {
    const db = makeFakeDb([])
    await expect(
      querySpans(db, { kind: 'by-run', id: '' }),
    ).rejects.toBeInstanceOf(SpansQueryError)
  })
})
