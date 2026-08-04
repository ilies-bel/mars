/**
 * Tests for the shadow-mode burn-in infrastructure (gate-burn-in.ts).
 *
 * Specification:
 *  - A gate in burn-in never fails verify even on a failing verdict.
 *  - N clean parses promote the gate to enforcing mode.
 *  - A gate whose input pipeline starves never records a clean parse and
 *    therefore never promotes — it stays in shadow mode indefinitely.
 *
 * Test boundary: public interfaces only.
 *  - gate-burn-in.ts: getGateBurnInStatus, recordGateParse, SHADOW_BURN_IN_COUNT
 *
 * DB setup: per-test in-memory PGlite clients so no state leaks between tests.
 * The module-level "schema ensured" latch is reset before each test via the
 * exported test helper.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { type DbClient } from './db.js'
import { getTestDb } from '../../../test/db-fixture.js'
import {
  SHADOW_BURN_IN_COUNT,
  getGateBurnInStatus,
  recordGateParse,
  resetGateBurnInSchemaLatchForTests,
} from './gate-burn-in'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the fork-local clean database satisfying the MonitorDb seam. */
const makeDb = (): Promise<DbClient> => getTestDb()

beforeEach(() => {
  resetGateBurnInSchemaLatchForTests()
})

// ---------------------------------------------------------------------------
// gate-burn-in module — state management
// ---------------------------------------------------------------------------

describe('getGateBurnInStatus', () => {
  it('returns inShadow: true and parseCount: 0 for a gate that has never been seen', async () => {
    const db = await makeDb()
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.inShadow).toBe(true)
    expect(status.parseCount).toBe(0)
  })
})

describe('recordGateParse', () => {
  it('increments parse count from 0 to 1', async () => {
    const db = await makeDb()
    const result = await recordGateParse(db, 'completeness')
    expect(result.parseCount).toBe(1)
    expect(result.promoted).toBe(false)
  })

  it('accumulates parse count across calls', async () => {
    const db = await makeDb()
    for (let i = 0; i < 5; i++) {
      await recordGateParse(db, 'completeness')
    }
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.parseCount).toBe(5)
    expect(status.inShadow).toBe(true)
  })

  it(`promotes the gate on exactly the ${SHADOW_BURN_IN_COUNT}th clean parse`, async () => {
    const db = await makeDb()
    let last = { parseCount: 0, promoted: false }
    for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
      last = await recordGateParse(db, 'completeness')
    }
    expect(last.parseCount).toBe(SHADOW_BURN_IN_COUNT)
    expect(last.promoted).toBe(true)
  })

  it('leaves gate in shadow mode one parse before the threshold', async () => {
    const db = await makeDb()
    for (let i = 0; i < SHADOW_BURN_IN_COUNT - 1; i++) {
      await recordGateParse(db, 'completeness')
    }
    const status = await getGateBurnInStatus(db, 'completeness')
    expect(status.inShadow).toBe(true)
  })

  it('does not increment parse_count once the gate is promoted', async () => {
    const db = await makeDb()
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
    const db = await makeDb()
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
