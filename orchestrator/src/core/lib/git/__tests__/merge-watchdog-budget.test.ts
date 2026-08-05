/**
 * Budget-ordering invariants for the merge watchdog.
 *
 * The merge watchdog is a wall-clock ceiling on ONE `mergeBranch` call holding
 * the .merge.lock. A rebase conflict dispatches the vcs-supervisor (Vega)
 * *inside* that span, with its own `VCS_SUPERVISOR_TIMEOUT_MS` budget.
 *
 * Regression: the watchdog was a flat 5 minutes while the supervisor was
 * allowed 30. The watchdog therefore always fired first and every
 * conflict-resolving merge died mid-session with
 *   merge:crashed/unclassified — aborted (watchdog) during step 'vega-supervisor'
 * so no merge that needed conflict resolution could ever land. The two
 * constants must not invert again.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_WATCHDOG_MS, VCS_SUPERVISOR_TIMEOUT_MS } from '../merge'
import { DEFAULT_CEILING_MS } from '../../../daemon/phantom-task-watchdog'

describe('merge watchdog budget ordering', () => {
  it('leaves room for a full vcs-supervisor session inside one merge', () => {
    // Strictly greater: equal budgets would race, and the watchdog would win
    // often enough to make conflict resolution flaky rather than broken.
    expect(DEFAULT_WATCHDOG_MS).toBeGreaterThan(VCS_SUPERVISOR_TIMEOUT_MS)
  })

  it('reserves headroom for the git work surrounding the supervisor', () => {
    // The rebase, the post-supervisor verification and the fast-forward all
    // run inside the same watchdog span, so the slack cannot be token.
    const slack = DEFAULT_WATCHDOG_MS - VCS_SUPERVISOR_TIMEOUT_MS
    expect(slack).toBeGreaterThanOrEqual(60_000)
  })

  it('still fires before the phantom sweep reaps the merging task', () => {
    // The merge worker's own watchdog must self-heal a wedged merge before the
    // phantom-task watchdog arrives; otherwise a stuck merge surfaces as a
    // phantom task instead of a merge failure. The phantom ceiling for tasks
    // parked in kind='merge' is twice the standard ceiling.
    expect(DEFAULT_WATCHDOG_MS).toBeLessThan(2 * DEFAULT_CEILING_MS)
  })
})
