/**
 * Unit tests for the two-phase pickNextImplement comparator logic.
 *
 * We test the exported pure helper `selectBestCandidate` directly so there is
 * no need to mount a live daemon or touch a real database.
 */
import { describe, expect, it } from 'vitest'
import { selectBestCandidate, type PickCandidate } from '../server'

const candidate = (
  id: string,
  priority: number,
  createdAt: string,
  originId: string | null,
): PickCandidate => ({ id, priority, createdAt, originId })

describe('selectBestCandidate', () => {
  it('returns null for an empty candidate list', () => {
    expect(selectBestCandidate([], new Set())).toBeNull()
  })

  it('returns the only candidate regardless of started-origin flag', () => {
    const c = candidate('t1', 1, '2024-01-01T00:00:00.000Z', 'origin-1')
    expect(selectBestCandidate([c], new Set())).toBe(c)
    expect(selectBestCandidate([c], new Set(['origin-1']))).toBe(c)
  })

  it('started-origin wins over fresh-origin at equal priority, even if newer', () => {
    // t1 belongs to a fresh arc (no sibling has started), created first.
    // t2 belongs to a started arc, created later.
    // t2 must win because its arc is already in flight.
    const t1 = candidate('t1', 1, '2024-01-01T00:00:00.000Z', 'origin-fresh')
    const t2 = candidate('t2', 1, '2024-01-02T00:00:00.000Z', 'origin-started')

    const result = selectBestCandidate([t1, t2], new Set(['origin-started']))
    expect(result?.id).toBe('t2')
  })

  it('started-origin wins regardless of candidate order in the input array', () => {
    const t1 = candidate('t1', 1, '2024-01-01T00:00:00.000Z', 'origin-fresh')
    const t2 = candidate('t2', 1, '2024-01-02T00:00:00.000Z', 'origin-started')

    // Same assertion but with reversed input order.
    const result = selectBestCandidate([t2, t1], new Set(['origin-started']))
    expect(result?.id).toBe('t2')
  })

  it('higher priority dominates the started-origin flag', () => {
    // t1: high priority, fresh arc.
    // t2: low priority, started arc.
    // t1 must win — priority is the top rule.
    const t1 = candidate('t1', 2, '2024-01-02T00:00:00.000Z', 'origin-fresh')
    const t2 = candidate('t2', 1, '2024-01-01T00:00:00.000Z', 'origin-started')

    const result = selectBestCandidate([t1, t2], new Set(['origin-started']))
    expect(result?.id).toBe('t1')
  })

  it('equal-priority, neither origin started → older createdAt wins (FIFO preserved)', () => {
    const t1 = candidate('t1', 1, '2024-01-01T00:00:00.000Z', 'origin-a')
    const t2 = candidate('t2', 1, '2024-01-02T00:00:00.000Z', 'origin-b')

    // No started origins — FIFO fallback: t1 (older) must win.
    const result = selectBestCandidate([t1, t2], new Set())
    expect(result?.id).toBe('t1')
  })

  it('null originId is treated as not-started and does not throw', () => {
    // t1 has null origin (should not crash), t2 has a started origin.
    const t1 = candidate('t1', 1, '2024-01-01T00:00:00.000Z', null)
    const t2 = candidate('t2', 1, '2024-01-02T00:00:00.000Z', 'origin-started')

    const result = selectBestCandidate([t1, t2], new Set(['origin-started']))
    // t2 wins despite being newer because its origin is started.
    expect(result?.id).toBe('t2')
  })

  it('null originId is treated as not-started (FIFO when other is also not started)', () => {
    const t1 = candidate('t1', 1, '2024-01-01T00:00:00.000Z', null)
    const t2 = candidate('t2', 1, '2024-01-02T00:00:00.000Z', null)

    // Both null-origin → neither is started → FIFO: t1 (older) wins.
    const result = selectBestCandidate([t1, t2], new Set())
    expect(result?.id).toBe('t1')
  })

  it('three candidates: highest-priority wins overall', () => {
    const t1 = candidate('t1', 3, '2024-01-03T00:00:00.000Z', 'origin-a')
    const t2 = candidate('t2', 1, '2024-01-01T00:00:00.000Z', 'origin-started')
    const t3 = candidate('t3', 2, '2024-01-02T00:00:00.000Z', 'origin-b')

    const result = selectBestCandidate([t1, t2, t3], new Set(['origin-started']))
    expect(result?.id).toBe('t1')
  })

  it('two candidates with same started origin use FIFO as final tie-break', () => {
    const t1 = candidate('t1', 1, '2024-01-01T00:00:00.000Z', 'origin-started')
    const t2 = candidate('t2', 1, '2024-01-02T00:00:00.000Z', 'origin-started')

    // Both started → FIFO: t1 (older) wins.
    const result = selectBestCandidate([t1, t2], new Set(['origin-started']))
    expect(result?.id).toBe('t1')
  })
})
