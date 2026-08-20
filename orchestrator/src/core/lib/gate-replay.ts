import { failureSignatureFamily } from './failure-signature.js'

/**
 * Gate replay fixtures (self-improvement-loop PRD, slice 12/21).
 *
 * A gate can be replayed against the failures that motivated it: capture
 * each motivating failure's verify output and the verdict it SHOULD have
 * produced, then run the gate's matcher over the fixture set and report how
 * many it would have caught. This module is deliberately pure (no
 * `resolveStateClient`, no DB, no network) so the eval harness the
 * modular-core program is building can reuse the exact same fixture format
 * and replay function without pulling in orchestrator state.
 */

/** One motivating failure, captured as a replayable fixture. */
export interface GateReplayFixture {
  /** The full `<failingStep>/<errorClass>` signature of the motivating failure. */
  signature: string
  /** The signature's family — same gate, same error class, kind-collapsed. */
  family: string
  /** The raw verify output the gate would have parsed, verbatim. */
  verifyOutput: string
  /**
   * What the gate SHOULD have decided for this fixture:
   *  - `'catch'` — the gate must fail verify (this was a real failure it exists to catch).
   *  - `'pass'`  — the gate must let this through (a legitimately passing case).
   */
  expected: 'catch' | 'pass'
  /** The task the fixture's verify output was captured from. */
  sourceTaskId: string
}

/** Build a {@link GateReplayFixture}, deriving `family` from `signature`. */
export const makeFixture = (input: {
  signature: string
  verifyOutput: string
  expected: 'catch' | 'pass'
  sourceTaskId: string
}): GateReplayFixture => ({
  signature: input.signature,
  family: failureSignatureFamily(input.signature),
  verifyOutput: input.verifyOutput,
  expected: input.expected,
  sourceTaskId: input.sourceTaskId,
})

/** Result of replaying a gate's matcher against a fixture set. */
export interface GateReplayResult {
  /** Number of fixtures where the matcher's verdict agreed with `expected`. */
  caught: number
  /** Number of fixtures where the matcher's verdict disagreed with `expected`. */
  missed: number
  /** Total fixtures replayed (`caught + missed`). */
  total: number
  /** The fixtures the matcher got wrong, for inspection. */
  misses: GateReplayFixture[]
}

/**
 * Replay a gate's matcher against fixtures captured from the failures that
 * motivated it. Pure — no DB or network access.
 *
 * `matcher` is the gate's decision function: given raw verify output, it
 * returns `true` when the gate would fail verify (catch the failure) and
 * `false` when it would let the run pass. A fixture is "caught" when the
 * matcher's verdict agrees with its `expected` field:
 *
 *  - `expected: 'catch'` agrees with matcher returning `true`
 *  - `expected: 'pass'`  agrees with matcher returning `false`
 *
 * Anything else is a miss, collected in `misses` in input order.
 */
export const replayGateAgainstFixtures = (
  matcher: (output: string) => boolean,
  fixtures: GateReplayFixture[],
): GateReplayResult => {
  const misses: GateReplayFixture[] = []
  for (const fixture of fixtures) {
    const wouldCatch = matcher(fixture.verifyOutput)
    const wantsCatch = fixture.expected === 'catch'
    if (wouldCatch !== wantsCatch) {
      misses.push(fixture)
    }
  }
  const total = fixtures.length
  const missed = misses.length
  return { caught: total - missed, missed, total, misses }
}
