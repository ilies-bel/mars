import { describe, it, expect } from 'vitest'
import { registerProvider, getProvider } from '../registry'
import { NoopProvider } from '../noop-provider'

describe('deployment registry', () => {
  it('returns undefined for an unregistered key', () => {
    expect(getProvider('definitely-not-registered-x9z')).toBeUndefined()
  })

  it('stores and retrieves a registered provider', () => {
    const provider = new NoopProvider()
    registerProvider('test-key-abc123', provider)
    expect(getProvider('test-key-abc123')).toBe(provider)
  })

  it('has NoopProvider pre-registered under "noop"', () => {
    const provider = getProvider('noop')
    expect(provider).toBeInstanceOf(NoopProvider)
  })

  it('registering under the same key replaces the previous provider', () => {
    const p1 = new NoopProvider()
    const p2 = new NoopProvider()
    registerProvider('replace-test-key', p1)
    registerProvider('replace-test-key', p2)
    expect(getProvider('replace-test-key')).toBe(p2)
  })
})
