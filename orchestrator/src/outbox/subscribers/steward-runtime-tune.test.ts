import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { makeSem } from '../../core/daemon/server.js'
import { startStewardRuntimeTune } from './steward-runtime-tune.js'

describe('steward-runtime-tune', () => {
  const setup = (cap = 12) => {
    const bus = new EventEmitter()
    const implementSem = makeSem(cap)
    const log = vi.fn()
    const writeChatAck = vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn> & ((text: string) => Promise<void>)
    startStewardRuntimeTune({
      bus,
      implementSem,
      baselineCap: cap,
      log,
      writeChatAck,
    })
    return { bus, implementSem, log, writeChatAck }
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
})
