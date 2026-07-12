/**
 * Tests for the subscriber name registry.
 *
 * The registry is a process-level singleton; vi.resetModules() resets it
 * between tests so each test starts with an empty set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('subscriber registry', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('knownSubscriberNames returns an empty set before any registration', async () => {
    const { knownSubscriberNames } = await import('../registry.js')
    expect(knownSubscriberNames().size).toBe(0)
  })

  it('registerSubscriberName adds a name that knownSubscriberNames reports', async () => {
    const { registerSubscriberName, knownSubscriberNames } = await import('../registry.js')
    registerSubscriberName('my-subscriber')
    expect(knownSubscriberNames().has('my-subscriber')).toBe(true)
  })

  it('registration is idempotent — calling twice keeps exactly one entry', async () => {
    const { registerSubscriberName, knownSubscriberNames } = await import('../registry.js')
    registerSubscriberName('dup-subscriber')
    registerSubscriberName('dup-subscriber')
    const names = knownSubscriberNames()
    expect(names.size).toBe(1)
    expect(names.has('dup-subscriber')).toBe(true)
  })

  it('multiple distinct names are all reported', async () => {
    const { registerSubscriberName, knownSubscriberNames } = await import('../registry.js')
    registerSubscriberName('sub-alpha')
    registerSubscriberName('sub-beta')
    const names = knownSubscriberNames()
    expect(names.has('sub-alpha')).toBe(true)
    expect(names.has('sub-beta')).toBe(true)
    expect(names.size).toBe(2)
  })

  it('an unregistered name is not reported as known', async () => {
    const { registerSubscriberName, knownSubscriberNames } = await import('../registry.js')
    registerSubscriberName('registered')
    expect(knownSubscriberNames().has('not-registered')).toBe(false)
  })

  it('importing a subscriber module registers its name in the shared registry', async () => {
    // This confirms the self-registration side-effect works end-to-end.
    await import('../subscribers/invalidator.js')
    const { knownSubscriberNames } = await import('../registry.js')
    expect(knownSubscriberNames().has('stall-invalidator')).toBe(true)
  })
})
