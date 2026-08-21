import { describe, expect, it } from 'vitest'
import { SWEEPS } from '../sweeps'
import { DRAINS } from '../drains'

// Both registries are armed by a `SWEEPS.map(...)` / `DRAINS.map(...)` over
// `setInterval`, so a malformed entry is not a compile error — it is a daemon
// that silently spins. The two failure modes worth guarding:
//
//   - a duplicate `name` makes the `[<name>] errored: …` log line ambiguous,
//     and means one of the two entries can never be identified in watch.log;
//   - a non-finite or non-positive `intervalMs()` (a typo'd env override
//     yielding NaN, say) is coerced by `setInterval` to a 1 ms period, turning
//     a five-minute reclamation sweep into a hot loop that pins a core.
const REGISTRIES = [
  { label: 'SWEEPS', entries: SWEEPS },
  { label: 'DRAINS', entries: DRAINS },
]

describe.each(REGISTRIES)('$label registry', ({ entries }) => {
  it('declares at least one entry', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it('gives every entry a unique name', () => {
    const names = entries.map((spec) => spec.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('resolves every cadence to a finite, positive number of milliseconds', () => {
    for (const spec of entries) {
      const ms = spec.intervalMs()
      expect(
        Number.isFinite(ms) && ms > 0,
        `${spec.name} resolved to interval ${ms}`,
      ).toBe(true)
    }
  })
})
