/**
 * Registry invariants for the daemon's periodic sweeps.
 *
 * `startSweeps` arms one interval per SWEEPS entry and reports a sweep's
 * rejections under `spec.name`, so a duplicate name silently misattributes
 * failures and a non-positive interval turns a 5-minute sweep into a hot
 * loop. Both are cheap to assert and neither needs a live daemon.
 */
import { describe, expect, it } from 'vitest'
import { SWEEPS } from '../sweeps'

describe('SWEEPS registry', () => {
  it('registers at least one sweep', () => {
    expect(SWEEPS.length).toBeGreaterThan(0)
  })

  it('gives every sweep a unique name', () => {
    const names = SWEEPS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('resolves every cadence to a positive number of milliseconds', () => {
    for (const spec of SWEEPS) {
      const ms = spec.intervalMs()
      expect(Number.isFinite(ms), `${spec.name} cadence is not finite`).toBe(true)
      expect(ms, `${spec.name} cadence must be positive`).toBeGreaterThan(0)
    }
  })
})
