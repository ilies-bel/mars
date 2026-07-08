import { beforeEach, describe, expect, it } from 'vitest'
import { apiCircuitBreaker } from '../api-circuit-breaker'

beforeEach(() => {
  // Reset to closed state before every test so tests are independent.
  apiCircuitBreaker.close()
})

describe('apiCircuitBreaker — initial state', () => {
  it('starts closed', () => {
    expect(apiCircuitBreaker.isOpen()).toBe(false)
  })

  it('reports null reason and openedAt when closed', () => {
    const s = apiCircuitBreaker.state()
    expect(s.open).toBe(false)
    expect(s.reason).toBeNull()
    expect(s.openedAt).toBeNull()
  })
})

describe('apiCircuitBreaker — open()', () => {
  it('sets open to true and records the reason', () => {
    apiCircuitBreaker.open('connection refused')
    expect(apiCircuitBreaker.isOpen()).toBe(true)
    expect(apiCircuitBreaker.state().reason).toBe('connection refused')
  })

  it('records the supplied timestamp as openedAt', () => {
    apiCircuitBreaker.open('timeout', 1_000_000)
    expect(apiCircuitBreaker.state().openedAt).toBe(1_000_000)
  })

  it('uses a non-null openedAt when no timestamp is supplied', () => {
    apiCircuitBreaker.open('timeout')
    expect(apiCircuitBreaker.state().openedAt).not.toBeNull()
  })
})

describe('apiCircuitBreaker — idempotent open()', () => {
  it('preserves the original reason on a second open()', () => {
    apiCircuitBreaker.open('first', 100)
    apiCircuitBreaker.open('second', 200)
    expect(apiCircuitBreaker.state().reason).toBe('first')
  })

  it('preserves the original openedAt on a second open()', () => {
    apiCircuitBreaker.open('first', 100)
    apiCircuitBreaker.open('second', 200)
    expect(apiCircuitBreaker.state().openedAt).toBe(100)
  })
})

describe('apiCircuitBreaker — close()', () => {
  it('transitions the breaker back to closed', () => {
    apiCircuitBreaker.open('connection refused', 500)
    apiCircuitBreaker.close()
    expect(apiCircuitBreaker.isOpen()).toBe(false)
  })

  it('clears reason after close()', () => {
    apiCircuitBreaker.open('connection refused', 500)
    apiCircuitBreaker.close()
    expect(apiCircuitBreaker.state().reason).toBeNull()
  })

  it('clears openedAt after close()', () => {
    apiCircuitBreaker.open('connection refused', 500)
    apiCircuitBreaker.close()
    expect(apiCircuitBreaker.state().openedAt).toBeNull()
  })
})

describe('apiCircuitBreaker — re-open after close()', () => {
  it('records a new reason when re-opened after close()', () => {
    apiCircuitBreaker.open('first failure', 100)
    apiCircuitBreaker.close()
    apiCircuitBreaker.open('second failure', 200)
    expect(apiCircuitBreaker.state().reason).toBe('second failure')
  })

  it('records a new openedAt when re-opened after close()', () => {
    apiCircuitBreaker.open('first failure', 100)
    apiCircuitBreaker.close()
    apiCircuitBreaker.open('second failure', 200)
    expect(apiCircuitBreaker.state().openedAt).toBe(200)
  })
})
