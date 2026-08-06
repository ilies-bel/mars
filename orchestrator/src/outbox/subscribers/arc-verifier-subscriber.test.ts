/**
 * Arc-verifier subscriber — behaviour tests.
 *
 * Verifies the handler inside drainArcVerifier through its public interface:
 * what events cause dispatchArcVerification to be called (or not).
 *
 * Key behaviours under test:
 *   1. Task-Arc (single task): task.terminal { reason: 'done' } → dispatch.
 *   2. Proposal-Arc (N slices): only the last slice completion (arc-done) triggers
 *      dispatch; intermediate done events (arc in-progress) are ignored so the
 *      per-daemon-lifetime dedup slot is not consumed prematurely.
 *   3. A task.terminal { reason: 'dropped' } event never triggers dispatch.
 *   4. An already-deduped arc returns skipped-dedup from dispatchArcVerification,
 *      which is observable as processed=0 from drainArcVerifier.
 *
 * System boundaries mocked:
 *   - drainWithStall: captures the handle fn; calls it directly so we can
 *     drive events without a real event-bus cursor.
 *   - createTaskStore: returns a minimal store stub whose arcStatus and
 *     getArcRescueAttempts return controllable values.
 *   - resolveOriginIdForTask: returns a controllable origin id.
 *   - incrementRescueSuccess: spy to assert KPI side-effect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BusEvent, EventName } from '../../bus/events.js'
import type { DrainWithStallArgs } from '../../core/daemon/subscriber-drain.js'

// ── Mock drainWithStall ───────────────────────────────────────────────────────
//
// Captures the `handle` callback so we can drive it with arbitrary events
// without needing a real event-bus cursor or DB. The mock returns
// { processed: <number> } matching the real contract.

let capturedHandle: ((event: BusEvent<EventName>) => Promise<boolean>) | null = null

vi.mock('../../core/daemon/subscriber-drain', () => ({
  drainWithStall: vi.fn(async (args: DrainWithStallArgs) => {
    capturedHandle = args.handle
    return { processed: 0 }
  }),
}))

// ── Mock resolveOriginIdForTask ───────────────────────────────────────────────

const resolveOriginIdMock = vi.hoisted(() => vi.fn(async (taskId: string) => taskId))
vi.mock('../../core/lib/origin', () => ({
  resolveOriginIdForTask: resolveOriginIdMock,
}))

// ── Mock createTaskStore ──────────────────────────────────────────────────────

const makeStoreMock = (arcStatusResult: string, rescueAttempts = 0) => ({
  arcStatus: vi.fn(async () => ({
    status: arcStatusResult,
    tasks: [],
    landedCommits: [],
  })),
  getArcRescueAttempts: vi.fn(async () => rescueAttempts),
})

const createTaskStoreMock = vi.hoisted(() => vi.fn())
vi.mock('../../core/store/task-store', () => ({
  createTaskStore: createTaskStoreMock,
}))

// ── Mock incrementRescueSuccess ───────────────────────────────────────────────

const incrementRescueSuccessMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../core/daemon/kpi-store', () => ({
  incrementRescueSuccess: incrementRescueSuccessMock,
}))

// ── Mock registerSubscriberName (no-op registry side effect) ─────────────────

vi.mock('../../outbox/registry', () => ({
  registerSubscriberName: vi.fn(),
}))

// ── Mock bus/subscribers (registerSubscriber no-op) ──────────────────────────

vi.mock('../../bus/subscribers', () => ({
  registerSubscriber: vi.fn(async () => {}),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { drainArcVerifier } = await import('./arc-verifier-subscriber.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal task.terminal BusEvent. */
function terminalEvent(
  eventId: number,
  taskId: string,
  reason: 'done' | 'dropped' | 'failed' | 'purged',
): BusEvent<EventName> {
  return {
    id: eventId,
    type: 'task.terminal',
    payload: { taskId, reason },
    ts: 1_000,
  } as unknown as BusEvent<EventName>
}

/** Fake DbClient — drainWithStall is mocked so the client is never used. */
const fakeClient = {} as import('../../core/lib/db.js').DbClient

// ─────────────────────────────────────────────────────────────────────────────

describe('arc-verifier subscriber — dispatch gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandle = null
    resolveOriginIdMock.mockImplementation(async (taskId: string) => taskId)
  })

  // ── Task-Arc: single task ───────────────────────────────────────────────────

  it('[task-arc] dispatches when a single-task arc reaches arc-done', async () => {
    createTaskStoreMock.mockReturnValue(makeStoreMock('arc-done'))
    const dispatchSpy = vi.fn(() => 'triggered' as const)

    await drainArcVerifier(fakeClient, dispatchSpy)

    // Simulate the single task completing.
    const result = await capturedHandle!(terminalEvent(1, 'task-alpha', 'done'))

    expect(result).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledOnce()
    expect(dispatchSpy).toHaveBeenCalledWith('task-alpha')
  })

  it('[task-arc] does NOT dispatch when a task.terminal { reason: "dropped" } event fires', async () => {
    createTaskStoreMock.mockReturnValue(makeStoreMock('arc-done'))
    const dispatchSpy = vi.fn(() => 'triggered' as const)

    await drainArcVerifier(fakeClient, dispatchSpy)
    const result = await capturedHandle!(terminalEvent(2, 'task-beta', 'dropped'))

    expect(result).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  // ── Proposal-Arc: N slices ──────────────────────────────────────────────────
  //
  // Each slice task carries origin_id = proposalId. When task A of a 2-slice
  // proposal completes, arcStatus is still 'in-progress' → no dispatch (dedup
  // slot preserved). When task B completes, arcStatus = 'arc-done' → dispatch.

  it('[proposal-arc] does NOT dispatch when the first slice task completes but the arc is still in-progress', async () => {
    const proposalId = 'prop-abc'
    resolveOriginIdMock.mockResolvedValue(proposalId)
    createTaskStoreMock.mockReturnValue(makeStoreMock('in-progress'))
    const dispatchSpy = vi.fn(() => 'triggered' as const)

    await drainArcVerifier(fakeClient, dispatchSpy)
    const result = await capturedHandle!(terminalEvent(10, 'slice-1', 'done'))

    expect(result).toBe(false)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('[proposal-arc] dispatches exactly once when the last slice task completes (arc-done)', async () => {
    const proposalId = 'prop-abc'
    resolveOriginIdMock.mockResolvedValue(proposalId)
    createTaskStoreMock.mockReturnValue(makeStoreMock('arc-done'))
    const dispatchSpy = vi.fn(() => 'triggered' as const)

    await drainArcVerifier(fakeClient, dispatchSpy)
    const result = await capturedHandle!(terminalEvent(11, 'slice-2', 'done'))

    expect(result).toBe(true)
    expect(dispatchSpy).toHaveBeenCalledOnce()
    expect(dispatchSpy).toHaveBeenCalledWith(proposalId)
  })

  it('[proposal-arc] the dedup slot is not consumed on intermediate events (in-progress arc)', async () => {
    const proposalId = 'prop-xyz'
    resolveOriginIdMock.mockResolvedValue(proposalId)
    const dispatchSpy = vi.fn(() => 'triggered' as const)

    // First call: in-progress — no dispatch
    createTaskStoreMock.mockReturnValue(makeStoreMock('in-progress'))
    await drainArcVerifier(fakeClient, dispatchSpy)
    await capturedHandle!(terminalEvent(20, 'slice-1', 'done'))

    // Second call: still in-progress — still no dispatch
    createTaskStoreMock.mockReturnValue(makeStoreMock('in-progress'))
    await drainArcVerifier(fakeClient, dispatchSpy)
    await capturedHandle!(terminalEvent(21, 'slice-2', 'done'))

    // Third call: arc-done — dispatch fires
    createTaskStoreMock.mockReturnValue(makeStoreMock('arc-done'))
    await drainArcVerifier(fakeClient, dispatchSpy)
    await capturedHandle!(terminalEvent(22, 'slice-3', 'done'))

    expect(dispatchSpy).toHaveBeenCalledOnce()
    expect(dispatchSpy).toHaveBeenCalledWith(proposalId)
  })

  // ── Task-Arc: no regression ─────────────────────────────────────────────────

  it('[task-arc] skipped-dedup result from dispatcher is returned as processed=false', async () => {
    createTaskStoreMock.mockReturnValue(makeStoreMock('arc-done'))
    const dispatchSpy = vi.fn(() => 'skipped-dedup' as const)

    await drainArcVerifier(fakeClient, dispatchSpy)
    const result = await capturedHandle!(terminalEvent(30, 'task-deduped', 'done'))

    // dispatch was called (arc-done), but the dedup said skip → not counted
    expect(dispatchSpy).toHaveBeenCalledOnce()
    expect(result).toBe(false)
  })

  // ── KPI rescue counter ──────────────────────────────────────────────────────

  it('[rescue] increments rescue KPI counter when arc-done and rescue attempts > 0', async () => {
    createTaskStoreMock.mockReturnValue(makeStoreMock('arc-done', 2))
    const dispatchSpy = vi.fn(() => 'triggered' as const)

    await drainArcVerifier(fakeClient, dispatchSpy)
    await capturedHandle!(terminalEvent(40, 'task-rescued', 'done'))

    expect(incrementRescueSuccessMock).toHaveBeenCalledOnce()
  })

  it('[rescue] does NOT increment rescue KPI counter when arc is still in-progress', async () => {
    createTaskStoreMock.mockReturnValue(makeStoreMock('in-progress', 2))
    const dispatchSpy = vi.fn(() => 'triggered' as const)

    await drainArcVerifier(fakeClient, dispatchSpy)
    await capturedHandle!(terminalEvent(41, 'task-in-progress', 'done'))

    expect(incrementRescueSuccessMock).not.toHaveBeenCalled()
  })

  it('[rescue] does NOT increment rescue KPI counter when rescue attempts = 0', async () => {
    createTaskStoreMock.mockReturnValue(makeStoreMock('arc-done', 0))
    const dispatchSpy = vi.fn(() => 'triggered' as const)

    await drainArcVerifier(fakeClient, dispatchSpy)
    await capturedHandle!(terminalEvent(42, 'task-no-rescue', 'done'))

    expect(incrementRescueSuccessMock).not.toHaveBeenCalled()
  })
})
