import { describe, expect, it, vi } from 'vitest'
import type { Task } from '../../queue.js'
import type { UsageSnapshotRow } from '../usage-snapshot-store.js'
import { shouldDeferDispatch } from '../dispatch-gate.js'

const config = { tightPct: 70, criticalPct: 90 }

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  priority: 0,
  deferrable: false,
  fixForTaskId: null,
  ...overrides,
} as Task)

const snapshot = (usedPct: number): UsageSnapshotRow => ({
  id: 1,
  capturedAt: '2026-07-31T12:00:00.000Z',
  inputTokens: 0,
  outputTokens: 0,
  windowKind: 'rolling',
  rawJson: {
    usedPct,
    nextResetAt: '2026-07-31T16:00:00.000Z',
  },
})

describe('shouldDeferDispatch', () => {
  it('defers low-priority work while the provider window is critical', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-31T12:00:00.000Z')

    expect(shouldDeferDispatch(task(), snapshot(90), config)).toEqual({
      defer: true,
      reason: 'usage pressure is critical',
    })

    vi.useRealTimers()
  })

  it('continues eligible work when pressure is ok', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-31T12:00:00.000Z')

    expect(shouldDeferDispatch(task(), snapshot(10), config)).toEqual({ defer: false })

    vi.useRealTimers()
  })

  it('never defers recovery work', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-31T12:00:00.000Z')

    expect(
      shouldDeferDispatch(
        task({ fixForTaskId: 'failed-task', deferrable: true }),
        snapshot(90),
        config,
      ),
    ).toEqual({ defer: false })

    vi.useRealTimers()
  })
})
