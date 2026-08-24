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

// The per-registry uniqueness check above cannot see a collision ACROSS the
// two registries, and both `startSweeps` and `startDrains` funnel a throwing
// body into the same daemon log under a bare `[<name>]` prefix. A sweep and a
// drain sharing a name therefore produce log lines an operator cannot
// attribute to either one — the exact ambiguity the within-registry check
// exists to prevent, just one level up.
it('keeps sweep and drain names disjoint', () => {
  const sweepNames = new Set(SWEEPS.map((spec) => spec.name))
  const collisions = DRAINS.map((spec) => spec.name).filter((name) => sweepNames.has(name))
  expect(collisions, `names claimed by both SWEEPS and DRAINS: ${collisions.join(', ')}`).toEqual(
    [],
  )
})
