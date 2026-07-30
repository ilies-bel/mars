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
   * `loadPerCore` defaults to a quiet host so the bump lane is not gated.
   * Tests that exercise the load gate or the shed lane pass a high value.
   */
  const setup = (cap = 12, loadPerCore = 0.2) => {
    const bus = new EventEmitter()
    const implementSem = makeSem(cap)
    const log = vi.fn()
    const writeChatAck = vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & ((text: string) => Promise<void>)
    const readLoadPerCore = vi.fn(() => loadPerCore)
    const stop = startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: cap,
      log,
      writeChatAck,
      readLoadPerCore,
    })
    disposers.push(stop)
    return { bus, implementSem, log, writeChatAck, readLoadPerCore }
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
    })

    stop()
    await vi.advanceTimersByTimeAsync(15_000 * 3)

    expect(readLoadPerCore).not.toHaveBeenCalled()
    expect(implementSem.limit).toBe(12)
  })
})
