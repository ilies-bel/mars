import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { makeSem } from '../../core/daemon/server.js'
import { startStewardRuntimeTune } from './steward-runtime-tune.js'

describe('steward-runtime-tune', () => {
  const disposers: Array<() => void> = []

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.()
    vi.useRealTimers()
  })

  /**
   * `loadPerCore` and `swap` default to a quiet host so neither gate fires.
   * Tests that exercise a gate, the shed lane, or the recover lane pass
   * explicit values. Both host readers MUST be injected — the real ones read
   * this machine's load average and shell out to `sysctl`.
   */
  /**
   * `pagingPps` is the paging rate the stubbed counter should imply. The
   * subscriber differences consecutive readings against the wall clock, so
   * the stub advances a monotonic counter by `pagingPps` per simulated
   * second and the test drives time with fake timers.
   */
  const setup = (
    cap = 12,
    loadPerCore = 0.2,
    { pagingPps = 0, baselineCap = cap }: { pagingPps?: number; baselineCap?: number } = {},
  ) => {
    const bus = new EventEmitter()
    const implementSem = makeSem(cap)
    const log = vi.fn()
    const writeChatAck = vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & ((text: string) => Promise<void>)
    const readLoadPerCore = vi.fn(() => loadPerCore)
    const startMs = Date.now()
    const readPagingCounter = vi.fn(async () =>
      Math.round(((Date.now() - startMs) / 1000) * pagingPps),
    )
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap,
      log,
      writeChatAck,
      readLoadPerCore,
      readPagingCounter,
    })
    disposers.push(stop)
    return { bus, implementSem, log, writeChatAck, readLoadPerCore, readPagingCounter }
  }

  /**
   * Advance far enough for the subscriber to take two paging samples, which
   * is the minimum needed to compute a rate at all. One interval past the
   * start-up sample.
   */
  const primePaging = async () => {
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
  }

  it('bumps implement cap on kpi.backlog.degraded', async () => {
    const { bus, implementSem, writeChatAck } = setup(12)
    expect(implementSem.limit).toBe(12)

    bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 65_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(implementSem.limit).toBe(16) // ceil(12 * 1.33) = 16
    expect(writeChatAck.mock.calls[0]![0]).toContain('12')
    expect(writeChatAck.mock.calls[0]![0]).toContain('16')
  })

  it('caps at 2× baseline', async () => {
    const { bus, implementSem, writeChatAck } = setup(10)
    // Manually set limit close to the 2× cap
    implementSem.limit = 19

    bus.emit('kpi.backlog.degraded', { pending: 20, cap: 19, sustainedMs: 70_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(implementSem.limit).toBe(20) // min(ceil(19*1.33)=26, 2*10=20) = 20
  })

  it('skips when already at max cap', async () => {
    const { bus, implementSem, log, writeChatAck } = setup(10)
    implementSem.limit = 20 // already at 2× baseline

    bus.emit('kpi.backlog.degraded', { pending: 25, cap: 20, sustainedMs: 80_000 })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(implementSem.limit).toBe(20)
    expect(writeChatAck).not.toHaveBeenCalled()
  })

  it('writes exactly one acknowledgment chat message', async () => {
    const { bus, writeChatAck } = setup(12)

    bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    const text = writeChatAck.mock.calls[0]![0]
    expect(text).toMatch(/bumped implement workers/)
    expect(text).toMatch(/backlog held above/)
  })

  it('does not raise a validation action-queue item', async () => {
    const { bus, writeChatAck } = setup(12)

    bus.emit('kpi.backlog.degraded', { pending: 15, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    // writeChatAck is called with kind='acknowledgment' (not 'validation')
    // The subscriber never raises an action-queue item — it calls writeChatAck only
    expect(writeChatAck).toHaveBeenCalledTimes(1)
  })

  // ── load gate on the bump lane ────────────────────────────────────────────

  it('refuses to bump when host load per core is at the ceiling', async () => {
    // 3.0 load/core — above the bump ceiling (1.5) but deliberately below the
    // shed trigger (4), so this exercises the bump gate alone. A value above 4
    // would also trip the shed lane on the start-up sample and the assertion
    // would no longer be about bumping.
    const { bus, implementSem, log, writeChatAck } = setup(12, 3)

    bus.emit('kpi.backlog.degraded', { pending: 400, cap: 12, sustainedMs: 90_000 })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(implementSem.limit).toBe(12) // unchanged
    expect(writeChatAck).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join(' ')).toMatch(/holding implement cap/)
  })

  it('still bumps when load is below the ceiling', async () => {
    const { bus, implementSem, writeChatAck } = setup(12, 1.4)

    bus.emit('kpi.backlog.degraded', { pending: 20, cap: 12, sustainedMs: 60_000 })
    await vi.waitFor(() => expect(writeChatAck).toHaveBeenCalledTimes(1))

    expect(implementSem.limit).toBe(16)
  })

  // ── shed lane ─────────────────────────────────────────────────────────────

  it('sheds implement cap when load per core is sustained high', async () => {
    vi.useFakeTimers()
    const { implementSem, writeChatAck, log } = setup(12, 10)

    // The subscriber samples once immediately on start, so advancing by 0 is
    // enough to observe exactly one shed. Advancing a full interval would
    // take two samples and shed twice.
    await vi.advanceTimersByTimeAsync(0)

    expect(implementSem.limit).toBe(8) // floor(12 * 0.67) = 8
    expect(log.mock.calls.flat().join(' ')).toMatch(/shed implement cap/)
    expect(writeChatAck).toHaveBeenCalledTimes(1)
    expect(writeChatAck.mock.calls[0]![0]).toMatch(/reduced implement workers from 12 to 8/)
  })

  it('sheds repeatedly while load stays high, never below 1', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(12, 10)

    // Ten sampling intervals — far more than needed to reach the floor.
    await vi.advanceTimersByTimeAsync(15_000 * 10)

    expect(implementSem.limit).toBe(1)
  })

  it('does not shed while load is normal', async () => {
    vi.useFakeTimers()
    const { implementSem, writeChatAck } = setup(12, 0.5)

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(12)
    expect(writeChatAck).not.toHaveBeenCalled()
  })

  it('stops sampling load after the disposer runs', async () => {
    vi.useFakeTimers()
    const bus = new EventEmitter()
    const implementSem = makeSem(12)
    const readLoadPerCore = vi.fn(() => 10)
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: 12,
      log: vi.fn(),
      writeChatAck: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & ((text: string) => Promise<void>),
      readLoadPerCore,
      readPagingCounter: vi.fn(async () => 0),
    })

    // The immediate start-up sample already ran; what the disposer must stop
    // is every *subsequent* one.
    await vi.advanceTimersByTimeAsync(0)
    const callsBeforeStop = readLoadPerCore.mock.calls.length
    expect(callsBeforeStop).toBe(1)

    stop()
    await vi.advanceTimersByTimeAsync(15_000 * 3)

    expect(readLoadPerCore.mock.calls.length).toBe(callsBeforeStop)
  })

  // ── paging pressure ───────────────────────────────────────────────────────
  //
  // Load average conflates CPU saturation with swap thrash: on Darwin and
  // Linux it counts uninterruptible sleep, so a paging host reports the same
  // number as a compute-bound one. These cover the memory signal on its own,
  // with load held at a quiet 0.2 throughout.
  //
  // Note these need TWO samples before any paging rate exists — a rate cannot
  // be observed from a single reading of a cumulative counter.

  it('sheds on paging activity even while load is normal', async () => {
    vi.useFakeTimers()
    const { implementSem, log } = setup(12, 0.2, { pagingPps: 5_000 })

    await primePaging()

    expect(implementSem.limit).toBe(8) // floor(12 * 0.67)
    expect(log.mock.calls.flat().join(' ')).toMatch(/shed implement cap .*\(paging 5000 pages\/s >= 500\)/)
  })

  it('names paging, not load, in the acknowledgment when paging tripped the shed', async () => {
    vi.useFakeTimers()
    const { writeChatAck } = setup(12, 0.2, { pagingPps: 5_000 })

    await primePaging()

    const text = writeChatAck.mock.calls[0]![0]
    expect(text).toMatch(/swapping at 5000 pages\/s/)
    expect(text).not.toMatch(/per core/)
  })

  it('refuses to bump while the host is paging, even when load and backlog allow it', async () => {
    vi.useFakeTimers()
    const { bus, implementSem, log, writeChatAck } = setup(12, 0.2, { pagingPps: 5_000 })

    // Establishing the rate also sheds 12 → 8, which legitimately acks. Clear
    // both spies so the assertions below are about the bump lane only.
    await primePaging()
    log.mockClear()
    writeChatAck.mockClear()

    bus.emit('kpi.backlog.degraded', { pending: 400, cap: 12, sustainedMs: 90_000 })
    await vi.advanceTimersByTimeAsync(0)

    expect(writeChatAck).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join(' ')).toMatch(/paging 5000 pages\/s >= 500/)
  })

  it('treats an unreadable paging counter as no pressure', async () => {
    vi.useFakeTimers()
    // The default reader returns null when it cannot determine paging; that
    // must never shed on its own, otherwise an unknown host tanks throughput.
    const bus = new EventEmitter()
    const implementSem = makeSem(12)
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: 12,
      log: vi.fn(),
      writeChatAck: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & ((text: string) => Promise<void>),
      readLoadPerCore: () => 0.2,
      readPagingCounter: async () => null,
    })
    disposers.push(stop)

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(12)
  })

  it('does not shed on a high swap occupancy that is not actively paging', async () => {
    vi.useFakeTimers()
    // The regression this whole signal change exists for: measured 2026-07-30,
    // swap sat at 91% occupancy with the counters completely static twenty
    // minutes after the thrash ended. A static counter is zero pressure, and
    // the cap must be free to recover.
    const { implementSem } = setup(1, 0.2, { pagingPps: 0, baselineCap: 4 })

    await primePaging()

    expect(implementSem.limit).toBeGreaterThan(1)
  })

  // ── recover lane ──────────────────────────────────────────────────────────

  it('climbs back to baseline one worker at a time once pressure clears', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, 0.2, { pagingPps: 0, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(0) // start-up sample
    expect(implementSem.limit).toBe(2)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(implementSem.limit).toBe(3)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(implementSem.limit).toBe(4)
  })

  it('samples immediately on start rather than waiting a full interval', async () => {
    vi.useFakeTimers()
    // Mirrors a daemon restart onto an already-loaded host: the cap comes up
    // at baseline and the dispatcher starts claiming slots at once, so the
    // first sample must not be an interval away. Uses the load signal because
    // it is readable from a single sample, unlike a paging rate.
    const { implementSem, log } = setup(3, 10)

    await vi.advanceTimersByTimeAsync(0)

    expect(implementSem.limit).toBe(2)
    expect(log.mock.calls.flat().join(' ')).toMatch(/shed implement cap 3 → 2 \(load\/core 10/)
  })

  it('stops recovering exactly at baseline, never above it', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, 0.2, { pagingPps: 0, baselineCap: 3 })

    await vi.advanceTimersByTimeAsync(15_000 * 10)

    expect(implementSem.limit).toBe(3)
  })

  it('does not recover while load sits in the dead band', async () => {
    vi.useFakeTimers()
    // 3.0 is below the shed trigger (4) but above the recover ceiling (2.5) —
    // the band where neither lane should act.
    const { implementSem } = setup(1, 3.0, { pagingPps: 0, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(1)
  })

  it('does not recover while the host is still paging', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, 0.2, { pagingPps: 5_000, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(1)
  })

  it('does not recover a cap that is already at or above baseline', async () => {
    vi.useFakeTimers()
    const { implementSem, writeChatAck } = setup(4, 0.2, { pagingPps: 0, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(4)
    expect(writeChatAck).not.toHaveBeenCalled()
  })

  it('sheds then recovers when paging spikes and stops', async () => {
    vi.useFakeTimers()
    const bus = new EventEmitter()
    const implementSem = makeSem(4)
    let pps = 5_000
    let counter = 0
    let lastMs = Date.now()
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: 4,
      log: vi.fn(),
      writeChatAck: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & ((text: string) => Promise<void>),
      readLoadPerCore: () => 0.2,
      readPagingCounter: async () => {
        const now = Date.now()
        counter += ((now - lastMs) / 1000) * pps
        lastMs = now
        return Math.round(counter)
      },
    })
    disposers.push(stop)

    // Thrash: 4 → 2 → 1, then held at the floor.
    await vi.advanceTimersByTimeAsync(15_000 * 5)
    expect(implementSem.limit).toBe(1)

    // Paging stops. Occupancy would still be high on a real host — the point
    // of using a rate is that recovery no longer waits on it, and no human
    // has to notice any of this happened.
    pps = 0
    await vi.advanceTimersByTimeAsync(15_000 * 6)
    expect(implementSem.limit).toBe(4)
  })
})
