import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpendControlDecision } from '../../core/daemon/spend-control/decide.js'

// Mock action-queue before importing the notifier.
vi.mock('../../core/lib/action-queue.js', () => ({
  raiseActionQueueItem: vi.fn(async () => 'mock-id'),
  supersedeActionQueueItemsBySignature: vi.fn(async () => []),
}))

import { emitSpendControlTransition } from '../spend-control-notifier.js'
import { raiseActionQueueItem, supersedeActionQueueItemsBySignature } from '../../core/lib/action-queue.js'

const mockRaise = raiseActionQueueItem as ReturnType<typeof vi.fn>
const mockSupersede = supersedeActionQueueItemsBySignature as ReturnType<typeof vi.fn>

function makeDecision(overrides: Partial<SpendControlDecision> = {}): SpendControlDecision {
  return {
    paused: false,
    perKindCeilings: {},
    suppressRecovery: false,
    reason: 'within budget',
    rampBackFactor: 1,
    ...overrides,
  }
}

describe('emitSpendControlTransition', () => {
  beforeEach(() => {
    mockRaise.mockClear()
    mockSupersede.mockClear()
  })

  it('skips emission on first tick (prev is null)', async () => {
    await emitSpendControlTransition(null, makeDecision())
    expect(mockRaise).not.toHaveBeenCalled()
    expect(mockSupersede).not.toHaveBeenCalled()
  })

  it('skips emission when state is unchanged (allow → allow)', async () => {
    const prev = makeDecision({ paused: false })
    const next = makeDecision({ paused: false })
    await emitSpendControlTransition(prev, next)
    expect(mockRaise).not.toHaveBeenCalled()
  })

  it('skips emission when state is unchanged (pause → pause)', async () => {
    const prev = makeDecision({ paused: true, reason: 'over budget' })
    const next = makeDecision({ paused: true, reason: 'still over budget' })
    await emitSpendControlTransition(prev, next)
    expect(mockRaise).not.toHaveBeenCalled()
  })

  it('raises action-queue row on allow → pause transition', async () => {
    const prev = makeDecision({ paused: false })
    const next = makeDecision({ paused: true, reason: 'spend rate 95% >= pause threshold 90%' })

    await emitSpendControlTransition(prev, next, { log: () => {} })

    expect(mockRaise).toHaveBeenCalledOnce()
    const call = mockRaise.mock.calls[0]![0]
    expect(call.kind).toBe('spend-control-notice')
    expect(call.signature).toBe('spend-control:paused')
    expect(call.payload.direction).toBe('paused')
    expect(call.payload.reason).toContain('spend rate 95%')
  })

  it('supersedes pause row and raises resumed row on pause → allow transition', async () => {
    const prev = makeDecision({ paused: true, reason: 'over budget' })
    const next = makeDecision({ paused: false, reason: 'spend rate 70% below resume threshold 80%', rampBackFactor: 0.5 })

    await emitSpendControlTransition(prev, next, { log: () => {} })

    expect(mockSupersede).toHaveBeenCalledOnce()
    expect(mockSupersede).toHaveBeenCalledWith(
      'spend-control-notice',
      'spend-control:paused',
      'status-changed',
      'dispatcher:spend-control',
    )

    expect(mockRaise).toHaveBeenCalledOnce()
    const call = mockRaise.mock.calls[0]![0]
    expect(call.kind).toBe('spend-control-notice')
    expect(call.signature).toBe('spend-control:resumed')
    expect(call.payload.direction).toBe('resumed')
    expect(call.payload.rampBackFactor).toBe(0.5)
  })

  it('does not raise duplicate on stable paused ticks', async () => {
    const paused = makeDecision({ paused: true, reason: 'over budget' })
    const stillPaused = makeDecision({ paused: true, reason: 'still over budget' })

    // First tick: null → paused (no emission — prev is null)
    await emitSpendControlTransition(null, paused, { log: () => {} })
    expect(mockRaise).not.toHaveBeenCalled()

    // Second tick: paused → paused (no emission — same state)
    await emitSpendControlTransition(paused, stillPaused, { log: () => {} })
    expect(mockRaise).not.toHaveBeenCalled()
  })
})
