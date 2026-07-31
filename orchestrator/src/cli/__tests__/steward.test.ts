import { describe, expect, it } from 'vitest'
import { registry } from '../commands'

describe('mars steward prompt commands', () => {
  it('exposes inspect, optimize, and ledger-backed revert as CLI leaves', () => {
    expect(registry.has('steward inspect')).toBe(true)
    expect(registry.has('steward optimize')).toBe(true)
    expect(registry.has('steward revert')).toBe(true)
  })
})
