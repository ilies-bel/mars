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
  const setup = (
    cap = 12,
    loadPerCore = 0.2,
    { swap = 0, baselineCap = cap }: { swap?: number; baselineCap?: number } = {},
  ) => {
    const bus = new EventEmitter()
    const implementSem = makeSem(cap)
    const log = vi.fn()
    const writeChatAck = vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & ((text: string) => Promise<void>)
    const readLoadPerCore = vi.fn(() => loadPerCore)
    const readSwapPressure = vi.fn(async () => swap)
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap,
      log,
      writeChatAck,
      readLoadPerCore,
      readSwapPressure,
    })
    disposers.push(stop)
    return { bus, implementSem, log, writeChatAck, readLoadPerCore, readSwapPressure }
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
    // 8.0 load/core — a saturated host. Backlog is high but adding workers
    // would make every in-flight run slower.
    const { bus, implementSem, log, writeChatAck } = setup(12, 8)

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
    expect(implementSem.limit).toBe(12)

    await vi.advanceTimersByTimeAsync(15_000)

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
      readSwapPressure: vi.fn(async () => 0),
    })

    stop()
    await vi.advanceTimersByTimeAsync(15_000 * 3)

    expect(readLoadPerCore).not.toHaveBeenCalled()
    expect(implementSem.limit).toBe(12)
  })

  // ── swap pressure ─────────────────────────────────────────────────────────
  //
  // Load average conflates CPU saturation with swap thrash: on Darwin and
  // Linux it counts uninterruptible sleep, so a paging host reports the same
  // number as a compute-bound one. These cover the memory signal on its own,
  // with load held at a quiet 0.2 throughout.

  it('sheds on swap pressure even while load is normal', async () => {
    vi.useFakeTimers()
    const { implementSem, writeChatAck, log } = setup(12, 0.2, { swap: 0.94 })

    await vi.advanceTimersByTimeAsync(15_000)

    expect(implementSem.limit).toBe(8) // floor(12 * 0.67)
    expect(log.mock.calls.flat().join(' ')).toMatch(/shed implement cap .*\(swap 94% >= 80%\)/)
  })

  it('names swap, not load, in the acknowledgment when swap tripped the shed', async () => {
    vi.useFakeTimers()
    const { writeChatAck } = setup(12, 0.2, { swap: 0.94 })

    await vi.advanceTimersByTimeAsync(15_000)

    const text = writeChatAck.mock.calls[0]![0]
    expect(text).toMatch(/swap reached 94%/)
    expect(text).not.toMatch(/per core/)
  })

  it('refuses to bump under swap pressure even when load and backlog allow it', async () => {
    const { bus, implementSem, log, writeChatAck } = setup(12, 0.2, { swap: 0.7 })

    bus.emit('kpi.backlog.degraded', { pending: 400, cap: 12, sustainedMs: 90_000 })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())

    expect(implementSem.limit).toBe(12) // unchanged
    expect(writeChatAck).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join(' ')).toMatch(/swap 70% >= 50%/)
  })

  it('treats an unreadable swap signal as no pressure', async () => {
    vi.useFakeTimers()
    // The default reader returns 0 when it cannot determine swap; a 0 must
    // never shed on its own, otherwise an unknown host tanks throughput.
    const { implementSem } = setup(12, 0.2, { swap: 0 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(12)
  })

  // ── recover lane ──────────────────────────────────────────────────────────

  it('climbs back to baseline one worker at a time once pressure clears', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, 0.2, { swap: 0.1, baselineCap: 4 })
    expect(implementSem.limit).toBe(1)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(implementSem.limit).toBe(2)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(implementSem.limit).toBe(3)
  })

  it('stops recovering exactly at baseline, never above it', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, 0.2, { swap: 0.1, baselineCap: 3 })

    await vi.advanceTimersByTimeAsync(15_000 * 10)

    expect(implementSem.limit).toBe(3)
  })

  it('does not recover while load sits in the dead band', async () => {
    vi.useFakeTimers()
    // 3.0 is below the shed trigger (4) but above the recover ceiling (2.5) —
    // the band where neither lane should act.
    const { implementSem } = setup(1, 3.0, { swap: 0.1, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(1)
  })

  it('does not recover while swap is still high', async () => {
    vi.useFakeTimers()
    const { implementSem } = setup(1, 0.2, { swap: 0.6, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(1)
  })

  it('does not recover a cap that is already at or above baseline', async () => {
    vi.useFakeTimers()
    const { implementSem, writeChatAck } = setup(4, 0.2, { swap: 0.1, baselineCap: 4 })

    await vi.advanceTimersByTimeAsync(15_000 * 4)

    expect(implementSem.limit).toBe(4)
    expect(writeChatAck).not.toHaveBeenCalled()
  })

  it('sheds then recovers when pressure spikes and clears', async () => {
    vi.useFakeTimers()
    const bus = new EventEmitter()
    const implementSem = makeSem(4)
    let swap = 0.94
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: 4,
      log: vi.fn(),
      writeChatAck: vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & ((text: string) => Promise<void>),
      readLoadPerCore: () => 0.2,
      readSwapPressure: async () => swap,
    })
    disposers.push(stop)

    // Thrash: 4 → 2 → 1, then held at the floor.
    await vi.advanceTimersByTimeAsync(15_000 * 5)
    expect(implementSem.limit).toBe(1)

    // Pressure clears — the whole point of the recover lane is that no human
    // has to notice this happened.
    swap = 0.05
    await vi.advanceTimersByTimeAsync(15_000 * 5)
    expect(implementSem.limit).toBe(4)
  })
})
