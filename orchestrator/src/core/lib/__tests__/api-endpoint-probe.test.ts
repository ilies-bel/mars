import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiCircuitBreaker } from '../api-circuit-breaker'
import { startApiEndpointProbe } from '../api-endpoint-probe'

beforeEach(() => {
  // Ensure the breaker starts closed and timers are faked.
  apiCircuitBreaker.close()
  vi.useFakeTimers()
})

afterEach(() => {
  apiCircuitBreaker.close()
  vi.useRealTimers()
})

describe('startApiEndpointProbe — idle when breaker is closed', () => {
  it('does not call probe when the breaker is closed', async () => {
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
    const stop = startApiEndpointProbe({ probe, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)

    expect(probe).not.toHaveBeenCalled()
    stop()
  })
})

describe('startApiEndpointProbe — probing while breaker is open', () => {
  it('calls probe on each tick while the breaker is open', async () => {
    apiCircuitBreaker.open('connection refused', 0)
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    const stop = startApiEndpointProbe({ probe, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)

    expect(probe).toHaveBeenCalledOnce()
    stop()
  })

  it('keeps the breaker open when probe returns false', async () => {
    apiCircuitBreaker.open('connection refused', 0)
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    const stop = startApiEndpointProbe({ probe, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)

    expect(apiCircuitBreaker.isOpen()).toBe(true)
    stop()
  })

  it('closes the breaker immediately when probe returns true', async () => {
    apiCircuitBreaker.open('connection refused', 0)
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
    const stop = startApiEndpointProbe({ probe, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)

    expect(apiCircuitBreaker.isOpen()).toBe(false)
    stop()
  })

  it('transitions open→open→closed when probe fails then succeeds', async () => {
    apiCircuitBreaker.open('connection refused', 0)

    let callCount = 0
    const probe = vi.fn<() => Promise<boolean>>().mockImplementation(async () => {
      callCount += 1
      return callCount > 1 // first call fails, second succeeds
    })

    const stop = startApiEndpointProbe({ probe, intervalMs: 1000 })

    // First tick: probe returns false → breaker stays open.
    await vi.advanceTimersByTimeAsync(1000)
    expect(apiCircuitBreaker.isOpen()).toBe(true)

    // Second tick: probe returns true → breaker closes.
    await vi.advanceTimersByTimeAsync(1000)
    expect(apiCircuitBreaker.isOpen()).toBe(false)
    expect(probe).toHaveBeenCalledTimes(2)

    stop()
  })

  it('keeps the breaker open when probe throws', async () => {
    apiCircuitBreaker.open('connection refused', 0)
    const probe = vi.fn<() => Promise<boolean>>().mockRejectedValue(
      new Error('ECONNREFUSED'),
    )
    const stop = startApiEndpointProbe({ probe, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)

    expect(apiCircuitBreaker.isOpen()).toBe(true)
    stop()
  })
})

describe('startApiEndpointProbe — stop()', () => {
  it('stop() prevents further probe calls after cancellation', async () => {
    apiCircuitBreaker.open('connection refused', 0)
    const probe = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
    const stop = startApiEndpointProbe({ probe, intervalMs: 1000 })

    stop()
    await vi.advanceTimersByTimeAsync(5000)

    expect(probe).not.toHaveBeenCalled()
  })
})
