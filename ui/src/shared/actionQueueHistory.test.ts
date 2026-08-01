/**
 * Unit tests for the action-queue History feature — schema layer.
 *
 * Pure function tests; no React render, no HTTP, no daemon required.
 * Covers:
 *   - actionQueueResolutionSchema parses valid resolution metadata.
 *   - actionQueueHistoryResponseSchema parses { rows, nextCursor } correctly,
 *     including the row-level fallback that coerces unknown kinds to failed-task.
 */
import { describe, expect, it } from 'bun:test'
import {
  actionQueueResolutionSchema,
  actionQueueHistoryResponseSchema,
} from './schemas'

// ---------------------------------------------------------------------------
// actionQueueResolutionSchema
// ---------------------------------------------------------------------------

describe('actionQueueResolutionSchema', () => {
  it('parses a fully-populated resolution object', () => {
    const raw = {
      resolvedAt: '2024-01-02T00:00:00.000Z',
      resolution: 'superseded',
      resolutionNote: 'origin-done',
      rootCause: 'flaky test',
      resolvedBy: 'daemon:auto-supersede',
    }
    const result = actionQueueResolutionSchema.parse(raw)
    expect(result.resolvedAt).toBe('2024-01-02T00:00:00.000Z')
    expect(result.resolution).toBe('superseded')
    expect(result.resolutionNote).toBe('origin-done')
    expect(result.rootCause).toBe('flaky test')
    expect(result.resolvedBy).toBe('daemon:auto-supersede')
  })

  it('parses when nullable fields are null', () => {
    const raw = {
      resolvedAt: '2024-01-02T00:00:00.000Z',
      resolution: null,
      resolutionNote: null,
      rootCause: null,
      resolvedBy: null,
    }
    const result = actionQueueResolutionSchema.parse(raw)
    expect(result.resolution).toBeNull()
    expect(result.resolutionNote).toBeNull()
    expect(result.rootCause).toBeNull()
    expect(result.resolvedBy).toBeNull()
  })

  it('rejects when resolvedAt is missing', () => {
    const raw = {
      resolution: 'dismissed',
      resolutionNote: null,
      rootCause: null,
      resolvedBy: null,
    }
    expect(() => actionQueueResolutionSchema.parse(raw)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// actionQueueHistoryResponseSchema
// ---------------------------------------------------------------------------

const makeHistoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'row-1',
  kind: 'failed',
  entityId: 'task-1',
  priority: 'high',
  title: 'Task failed',
  body: 'Some error',
  at: '2024-01-01T00:00:00.000Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [],
  diagnosis: null,
  failureReasonCode: null,
  resolution: {
    resolvedAt: '2024-01-02T00:00:00.000Z',
    resolution: 'superseded',
    resolutionNote: 'origin-done',
    rootCause: null,
    resolvedBy: 'daemon:auto-supersede',
  },
  ...overrides,
})

describe('actionQueueHistoryResponseSchema', () => {
  it('parses a response with rows and nextCursor=null', () => {
    const raw = {
      rows: [makeHistoryRow()],
      nextCursor: null,
    }
    const result = actionQueueHistoryResponseSchema.parse(raw)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.id).toBe('row-1')
    expect(result.nextCursor).toBeNull()
  })

  it('parses a response with a non-null nextCursor', () => {
    const raw = {
      rows: [makeHistoryRow()],
      nextCursor: 'eyJyZXNvbHZlZEF0IjoiMjAyNC0wMS0wMlQwMDowMDowMC4wMDBaIiwiaWQiOiJyb3ctMSJ9',
    }
    const result = actionQueueHistoryResponseSchema.parse(raw)
    expect(result.nextCursor).not.toBeNull()
  })

  it('parses an empty rows array with nextCursor=null', () => {
    const result = actionQueueHistoryResponseSchema.parse({ rows: [], nextCursor: null })
    expect(result.rows).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
  })

  it('resolution field on a row is preserved after parsing', () => {
    const raw = {
      rows: [makeHistoryRow()],
      nextCursor: null,
    }
    const result = actionQueueHistoryResponseSchema.parse(raw)
    const row = result.rows[0]!
    expect(row.resolution).not.toBeNull()
    expect(row.resolution!.resolvedAt).toBe('2024-01-02T00:00:00.000Z')
    expect(row.resolution!.resolution).toBe('superseded')
    expect(row.resolution!.resolvedBy).toBe('daemon:auto-supersede')
  })

  it('resolution field is preserved for a draft-proposal history row', () => {
    const raw = {
      rows: [
        makeHistoryRow({
          id: 'dp-row-1',
          kind: 'draft-proposal',
          entityId: 'prop-abc',
          errorKind: 'draft-proposal',
          resolution: {
            resolvedAt: '2024-01-03T12:00:00.000Z',
            resolution: 'dismissed',
            resolutionNote: null,
            rootCause: null,
            resolvedBy: 'user:dismiss',
          },
        }),
      ],
      nextCursor: null,
    }
    const result = actionQueueHistoryResponseSchema.parse(raw)
    const row = result.rows[0]!
    expect(row.kind).toBe('draft-proposal')
    expect(row.resolution).not.toBeNull()
    expect(row.resolution!.resolution).toBe('dismissed')
    expect(row.resolution!.resolvedBy).toBe('user:dismiss')
  })

  it('coerces an unknown kind to failed without dropping the row', () => {
    const raw = {
      rows: [
        makeHistoryRow({ kind: 'some-unknown-kind' }),
      ],
      nextCursor: null,
    }
    let result: ReturnType<typeof actionQueueHistoryResponseSchema.parse> | undefined
    expect(() => {
      result = actionQueueHistoryResponseSchema.parse(raw)
    }).not.toThrow()
    expect(result!.rows).toHaveLength(1)
    expect(result!.rows[0]!.kind).toBe('failed')
  })

  it('does not discard other rows when one row has an unknown kind', () => {
    const raw = {
      rows: [
        makeHistoryRow({ id: 'row-1', kind: 'weird-future-kind' }),
        makeHistoryRow({ id: 'row-2', kind: 'failed' }),
      ],
      nextCursor: null,
    }
    const result = actionQueueHistoryResponseSchema.parse(raw)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]!.kind).toBe('failed')
    expect(result.rows[1]!.kind).toBe('failed')
  })
})
