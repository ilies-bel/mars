/**
 * Unit tests for the pure assembleDelta / clampWywaDeltaLimit functions.
 *
 * No DB, no HTTP server, no PGlite — just the in-process assembler logic.
 */
import { describe, expect, it } from 'vitest'
import {
  assembleDelta,
  clampWywaDeltaLimit,
  DEFAULT_WYWA_LIMIT,
  MAX_WYWA_LIMIT,
} from './wywa-delta'

// ── clampWywaDeltaLimit ───────────────────────────────────────────────────────

describe('clampWywaDeltaLimit', () => {
  it('returns DEFAULT_WYWA_LIMIT when raw is null', () => {
    expect(clampWywaDeltaLimit(null)).toBe(DEFAULT_WYWA_LIMIT)
  })

  it('clamps to 1 when raw < 1', () => {
    expect(clampWywaDeltaLimit(0)).toBe(1)
    expect(clampWywaDeltaLimit(-5)).toBe(1)
  })

  it('clamps to MAX_WYWA_LIMIT when raw exceeds it', () => {
    expect(clampWywaDeltaLimit(9999)).toBe(MAX_WYWA_LIMIT)
    expect(clampWywaDeltaLimit(MAX_WYWA_LIMIT + 1)).toBe(MAX_WYWA_LIMIT)
  })

  it('passes through a valid mid-range value', () => {
    expect(clampWywaDeltaLimit(10)).toBe(10)
  })
})

// ── assembleDelta ─────────────────────────────────────────────────────────────

const baseInput = {
  releaseNotes: [],
  recoveryEvents: [],
  autoRuns: [],
  throttledThreads: [],
  evaporatedThreads: [],
  since: null,
  limit: DEFAULT_WYWA_LIMIT,
} as const

describe('assembleDelta — empty sources', () => {
  it('returns empty events and zero andMore when there is no activity', () => {
    const result = assembleDelta({ ...baseInput })
    expect(result.events).toEqual([])
    expect(result.andMore).toBe(0)
  })
})

describe('assembleDelta — merge events', () => {
  it('converts a release note into a merge event', () => {
    const result = assembleDelta({
      ...baseInput,
      releaseNotes: [{ title: 'Add login flow', landedAt: '2026-07-20T10:00:00.000Z' }],
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({
      kind: 'merge',
      summary: 'Merged: Add login flow',
      at: '2026-07-20T10:00:00.000Z',
    })
  })

  it('excludes release notes at or before the since boundary', () => {
    const result = assembleDelta({
      ...baseInput,
      releaseNotes: [
        { title: 'New', landedAt: '2026-07-10T12:00:00.000Z' },
        { title: 'Old', landedAt: '2026-07-01T00:00:00.000Z' },
      ],
      since: '2026-07-05T00:00:00.000Z',
    })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.summary).toBe('Merged: New')
  })
})

describe('assembleDelta — failure-recovered events', () => {
  it('uses originId as the task reference when present', () => {
    const result = assembleDelta({
      ...baseInput,
      recoveryEvents: [
        { timestamp: '2026-07-20T11:00:00.000Z', taskId: 'fix-1', originId: 'arc-abc' },
      ],
    })
    expect(result.events[0]).toMatchObject({
      kind: 'failure-recovered',
      summary: 'Task arc-abc failed and recovered',
    })
  })

  it('falls back to taskId when originId is null', () => {
    const result = assembleDelta({
      ...baseInput,
      recoveryEvents: [
        { timestamp: '2026-07-20T11:00:00.000Z', taskId: 'fix-1', originId: null },
      ],
    })
    expect(result.events[0]?.summary).toContain('fix-1')
  })

  it('uses a generic message when both taskId and originId are null', () => {
    const result = assembleDelta({
      ...baseInput,
      recoveryEvents: [
        { timestamp: '2026-07-20T11:00:00.000Z', taskId: null, originId: null },
      ],
    })
    expect(result.events[0]?.summary).toContain('A task failed')
  })
})

describe('assembleDelta — auto-recipe events', () => {
  it('formats an auto-recipe run with taskId', () => {
    const result = assembleDelta({
      ...baseInput,
      autoRuns: [
        { actionOp: 'restart', taskId: 'task-xyz', signature: 'verify:typecheck', ranAt: '2026-07-20T09:00:00.000Z' },
      ],
    })
    expect(result.events[0]).toMatchObject({
      kind: 'auto-recipe',
      summary: 'Auto-restart on task-xyz (verify:typecheck)',
    })
  })

  it('omits the task fragment when taskId is null', () => {
    const result = assembleDelta({
      ...baseInput,
      autoRuns: [
        { actionOp: 'purge', taskId: null, signature: 'sig', ranAt: '2026-07-20T09:00:00.000Z' },
      ],
    })
    expect(result.events[0]?.summary).toBe('Auto-purge (sig)')
  })
})

describe('assembleDelta — throttle events', () => {
  it('formats a throttled thread event', () => {
    const result = assembleDelta({
      ...baseInput,
      throttledThreads: [{ id: 'thread-1', updatedAt: '2026-07-20T08:00:00.000Z' }],
    })
    expect(result.events[0]).toMatchObject({
      kind: 'throttle',
      summary: 'Rate limit hit on chat thread thread-1',
    })
  })
})

describe('assembleDelta — evaporated-thread events', () => {
  it('formats an evaporated thread event', () => {
    const result = assembleDelta({
      ...baseInput,
      evaporatedThreads: [{ id: 'thread-2', evaporatedAt: '2026-07-20T07:00:00.000Z' }],
    })
    expect(result.events[0]).toMatchObject({
      kind: 'evaporated-thread',
      summary: 'Idle thread thread-2 evaporated',
    })
  })
})

describe('assembleDelta — sorting and capping', () => {
  it('returns events sorted newest first', () => {
    const result = assembleDelta({
      ...baseInput,
      releaseNotes: [
        { title: 'Old', landedAt: '2026-07-01T00:00:00.000Z' },
        { title: 'New', landedAt: '2026-07-20T00:00:00.000Z' },
      ],
    })
    expect(result.events[0]?.summary).toBe('Merged: New')
    expect(result.events[1]?.summary).toBe('Merged: Old')
  })

  it('caps events at limit and reports andMore for the remainder', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      title: `Arc ${i}`,
      landedAt: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    }))
    const result = assembleDelta({
      ...baseInput,
      releaseNotes: entries,
      limit: 2,
    })
    expect(result.events).toHaveLength(2)
    expect(result.andMore).toBe(3)
  })

  it('reports andMore=0 when all events fit within the limit', () => {
    const result = assembleDelta({
      ...baseInput,
      releaseNotes: [{ title: 'Only one', landedAt: '2026-07-01T00:00:00.000Z' }],
      limit: 10,
    })
    expect(result.events).toHaveLength(1)
    expect(result.andMore).toBe(0)
  })

  it('mixes event kinds in newest-first order', () => {
    const result = assembleDelta({
      ...baseInput,
      releaseNotes: [{ title: 'Merge', landedAt: '2026-07-03T00:00:00.000Z' }],
      autoRuns: [
        { actionOp: 'restart', taskId: null, signature: 'sig', ranAt: '2026-07-05T00:00:00.000Z' },
      ],
      throttledThreads: [{ id: 'th-1', updatedAt: '2026-07-01T00:00:00.000Z' }],
    })
    // 5 (autoRun) > 3 (merge) > 1 (throttle)
    expect(result.events.map((e) => e.kind)).toEqual(['auto-recipe', 'merge', 'throttle'])
  })
})
