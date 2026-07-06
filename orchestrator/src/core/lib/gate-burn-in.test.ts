/**
 * Tests for the shadow-mode burn-in infrastructure (gate-burn-in.ts) and
 * its integration with checkCompletenessGate (verify.ts).
 *
 * Specification:
 *  - A gate in burn-in never fails verify even on a failing verdict.
 *  - N clean parses promote the gate to enforcing mode.
 *  - A gate whose input pipeline starves (coderText always empty → report
 *    always `absent`) never records a clean parse and therefore never
 *    promotes — it stays in shadow mode indefinitely.
 *
 * Test boundary: public interfaces only.
 *  - gate-burn-in.ts: getGateBurnInStatus, recordGateParse, SHADOW_BURN_IN_COUNT
 *  - verify.ts: checkCompletenessGate (called with burnInDb set)
 *
 * DB setup: per-test in-memory libsql clients so no state leaks between tests.
 * The module-level "schema ensured" latch is reset before each test via the
 * exported test helper.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'
import {
  SHADOW_BURN_IN_COUNT,
  getGateBurnInStatus,
  recordGateParse,
  resetGateBurnInSchemaLatchForTests,
} from './gate-burn-in'
import { checkCompletenessGate } from './git/verify'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh in-memory libsql client satisfying the MonitorDb seam. */
const makeDb = (): Client => createClient({ url: ':memory:' })

/**
 * Build a minimal valid completion-report block with one `done` criterion.
 * Evidence is a plain description (no file path, no SHA) so the evidence
 * check accepts it unconditionally — verify.ts passes non-verifiable evidence
 * (test names, descriptions) without a physical check.
 */
const makePassingReport = (): string =>
  '```completion-report\n' +
  '- [done] work completed — evidence: all unit tests pass\n' +
  '```'

/**
 * Build a completion-report block with one `partial` criterion — the gate
 * will return a failing verdict (incomplete).
 */
const makeFailingReport = (): string =>
  '```completion-report\n' +
  '- [partial] work incomplete — evidence: nothing yet\n' +
  '```'

/** A worktree path guaranteed to have no files under it. */
const EMPTY_WORKTREE = '/absolutely-nonexistent-worktree-dir-xyz987'

beforeEach(() => {
  resetGateBurnInSchemaLatchForTests()
})

// ---------------------------------------------------------------------------
// gate-burn-in module — state management
// ---------------------------------------------------------------------------

describe('getGateBurnInStatus', () => {
  it('returns inShadow: true and parseCount: 0 for a gate that has never been seen', async () => {
    const db = makeDb()
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.inShadow).toBe(true)
    expect(status.parseCount).toBe(0)
  })
})

describe('recordGateParse', () => {
  it('increments parse count from 0 to 1', async () => {
    const db = makeDb()
    const result = await recordGateParse(db, 'completeness')
    expect(result.parseCount).toBe(1)
    expect(result.promoted).toBe(false)
  })

  it('accumulates parse count across calls', async () => {
    const db = makeDb()
    for (let i = 0; i < 5; i++) {
      await recordGateParse(db, 'completeness')
    }
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.parseCount).toBe(5)
    expect(status.inShadow).toBe(true)
  })

  it(`promotes the gate on exactly the ${SHADOW_BURN_IN_COUNT}th clean parse`, async () => {
    const db = makeDb()
    let last = { parseCount: 0, promoted: false }
    for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
      last = await recordGateParse(db, 'completeness')
    }
    expect(last.parseCount).toBe(SHADOW_BURN_IN_COUNT)
    expect(last.promoted).toBe(true)
  })

  it('leaves gate in shadow mode one parse before the threshold', async () => {
    const db = makeDb()
    for (let i = 0; i < SHADOW_BURN_IN_COUNT - 1; i++) {
      await recordGateParse(db, 'completeness')
    }
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.inShadow).toBe(true)
  })

  it('does not increment parse_count once the gate is promoted', async () => {
    const db = makeDb()
    // Promote the gate
    for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
      await recordGateParse(db, 'completeness')
    }
    // Additional parses after promotion
    await recordGateParse(db, 'completeness')
    await recordGateParse(db, 'completeness')
    const status = await getGateBurnInStatus(db, 'completeness')
    // parse_count stays at the threshold — no further increments post-promotion
    expect(status.parseCount).toBe(SHADOW_BURN_IN_COUNT)
    expect(status.inShadow).toBe(false)
  })

  it('tracks burn-in state independently per gate name', async () => {
    const db = makeDb()
    for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
      await recordGateParse(db, 'gate-a')
    }
    const statusA = await getGateBurnInStatus(db, 'gate-a')
    const statusB = await getGateBurnInStatus(db, 'gate-b')
    expect(statusA.inShadow).toBe(false)
    expect(statusB.inShadow).toBe(true)
    expect(statusB.parseCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// checkCompletenessGate — shadow-mode behaviour
// ---------------------------------------------------------------------------

describe('checkCompletenessGate shadow mode', () => {
  it('a gate in burn-in with a failing verdict does not fail verify', async () => {
    const db = makeDb()
    // Gate has never run — fully in burn-in, parse_count = 0
    const step = await checkCompletenessGate({
      coderText: makeFailingReport(),
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
      burnInDb: db,
    })
    // Must pass even though the raw verdict would be 'incomplete'
    expect(step.passed).toBe(true)
    // Output must be prefixed to signal shadow mode
    expect(step.output).toMatch(/\[shadow-mode\]/)
    // The original verdict text must still be present (logged, not discarded)
    expect(step.output).toContain('incomplete')
  })

  it('a gate in burn-in with a passing verdict passes normally', async () => {
    const db = makeDb()
    const step = await checkCompletenessGate({
      coderText: makePassingReport(),
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
      burnInDb: db,
    })
    expect(step.passed).toBe(true)
    // Passing verdict is NOT shadow-prefixed — it was already a pass
    expect(step.output).not.toContain('[shadow-mode]')
  })

  it('enforces (can fail verify) once the gate is promoted', async () => {
    const db = makeDb()
    // Promote the gate by recording N clean parses directly
    for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
      await recordGateParse(db, 'completeness')
    }
    // Gate is now promoted — a failing verdict must fail verify
    const step = await checkCompletenessGate({
      coderText: makeFailingReport(),
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
      burnInDb: db,
    })
    expect(step.passed).toBe(false)
    expect(step.output).not.toContain('[shadow-mode]')
  })

  it('records a clean parse when the gate finds a completion-report block (even a failing verdict)', async () => {
    const db = makeDb()
    // The failing report HAS a completion-report block — it IS a clean parse
    await checkCompletenessGate({
      coderText: makeFailingReport(),
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
      burnInDb: db,
    })
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.parseCount).toBe(1)
  })

  it('never promotes when coderText is always empty (starvation — gate input pipeline starved)', async () => {
    const db = makeDb()
    // Run the gate many more times than the threshold with empty coderText
    const runsNeeded = SHADOW_BURN_IN_COUNT * 3
    for (let i = 0; i < runsNeeded; i++) {
      const step = await checkCompletenessGate({
        coderText: '', // empty — triggers absent verdict every time
        changedFiles: [],
        worktreePath: EMPTY_WORKTREE,
        branch: 'task/test',
        burnInDb: db,
      })
      // Still in shadow mode → always passed
      expect(step.passed).toBe(true)
    }
    // Gate must still be in shadow mode — never saw any data
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.inShadow).toBe(true)
    expect(status.parseCount).toBe(0)
  })

  it('does not count absent verdicts toward the promotion threshold', async () => {
    const db = makeDb()
    // Run N-1 times with empty coderText (absent — not a clean parse)
    for (let i = 0; i < SHADOW_BURN_IN_COUNT - 1; i++) {
      await checkCompletenessGate({
        coderText: '',
        changedFiles: [],
        worktreePath: EMPTY_WORKTREE,
        branch: 'task/test',
        burnInDb: db,
      })
    }
    // Now run with an actual failing report (IS a clean parse)
    await checkCompletenessGate({
      coderText: makeFailingReport(),
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
      burnInDb: db,
    })
    // Only 1 clean parse was recorded — gate is still in burn-in
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.parseCount).toBe(1)
    expect(status.inShadow).toBe(true)
  })

  it('auto-promotes after exactly N clean parses through the gate function', async () => {
    const db = makeDb()
    // Run N times with a real (failing) completion-report block
    for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
      const step = await checkCompletenessGate({
        coderText: makeFailingReport(),
        changedFiles: [],
        worktreePath: EMPTY_WORKTREE,
        branch: 'task/test',
        burnInDb: db,
      })
      // All N runs are still in shadow mode
      expect(step.passed).toBe(true)
    }
    // Gate now promoted — next failing run enforces
    const step = await checkCompletenessGate({
      coderText: makeFailingReport(),
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
      burnInDb: db,
    })
    expect(step.passed).toBe(false)
    expect(step.output).not.toContain('[shadow-mode]')
  })

  it('enforces immediately when no burnInDb is provided (backwards-compatible)', async () => {
    // No burnInDb — original behaviour, gate enforces from the start
    const step = await checkCompletenessGate({
      coderText: makeFailingReport(),
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
      // burnInDb intentionally omitted
    })
    expect(step.passed).toBe(false)
    expect(step.output).not.toContain('[shadow-mode]')
  })
})
