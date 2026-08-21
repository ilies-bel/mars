/**
 * Tests for ADR-0099 "gate promotion requires replay against motivating
 * failures" (PRD 1e904a61, slice 13).
 *
 * Specification under test: a shadow check no longer promotes on
 * {@link SHADOW_BURN_IN_COUNT} clean parses alone. At the burn-in threshold the
 * check is replayed against the motivating-failure fixtures captured for its
 * signature, and it promotes only when the replay caught at least one fixture
 * and missed none. A check that parses cleanly but re-catches none of the
 * failures that motivated it stays in shadow, and the verdict is persisted on
 * the gate's burn-in row so `mars enrich list` can explain why.
 *
 * The replay matcher is the deterministic classification pipeline itself:
 * a fixture's captured `verifyOutput` is re-run through
 * `computeFailureSignature` and compared family-wise against the record's own
 * signature. So a fixture whose output still classifies as
 * `typecheck-cannot-find-name` is caught, and one that classifies as
 * `typecheck-cannot-find-module` is missed.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { getTestDb } from '../../../../test/db-fixture.js'
import type { DbClient } from '../db.js'
import {
  approveEnrichment,
  enrichStepName,
  getEnrichment,
  listEnrichments,
  observeFailureSignature,
  recordEnrichmentShadowRuns,
  resetGateEnrichmentSchemaLatchForTests,
} from '../gate-enrichment.js'
import {
  SHADOW_BURN_IN_COUNT,
  getGateBurnInStatus,
  resetGateBurnInSchemaLatchForTests,
} from '../gate-burn-in.js'
import { runCommandInProcess, makeFakeDaemon } from '../../../cli/test-adapter.js'
import { createTaskStore } from '../../store/task-store.js'
import { resolveContext } from '../../context.js'

/** An encodable signature (command family) with a real classifier rule. */
const SIG = 'verify:typecheck/typecheck-cannot-find-name'

/** Output that still classifies into SIG's family — a caught fixture. */
const CATCHING_OUTPUT = "src/a.ts(3,7): error TS2304: Cannot find name 'x'."
/** Output that classifies into a DIFFERENT family — a missed fixture. */
const MISSING_OUTPUT = "src/a.ts(1,1): error TS2307: Cannot find module './b'."

/**
 * Seed an approved shadow check for {@link SIG} whose single captured
 * motivating failure has the given verify output.
 */
const seedShadowCheck = async (
  db: DbClient,
  errorOutput: string,
): Promise<void> => {
  await observeFailureSignature(db, {
    signature: SIG,
    originTaskId: 'task-origin-1',
    errorOutput,
    draftStep: {
      name: enrichStepName(SIG),
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      required: true,
      dir: '.',
    },
  })
  await approveEnrichment(db, SIG, 'tester')
}

/** Drive the check through a full clean-parse burn-in window. */
const burnIn = async (db: DbClient): Promise<void> => {
  for (let i = 0; i < SHADOW_BURN_IN_COUNT; i++) {
    await recordEnrichmentShadowRuns(db, [
      { name: enrichStepName(SIG), passed: true, output: 'ok' },
    ])
  }
}

beforeEach(() => {
  resetGateEnrichmentSchemaLatchForTests()
  resetGateBurnInSchemaLatchForTests()
})

describe('gate promotion requires replay against motivating failures', () => {
  it('promotes at the burn-in threshold when the replay re-catches the motivating failure', async () => {
    const db = await getTestDb()
    await seedShadowCheck(db, CATCHING_OUTPUT)

    await burnIn(db)

    const record = await getEnrichment(db, SIG)
    expect(record?.status).toBe('enforcing')
    const status = await getGateBurnInStatus(db, enrichStepName(SIG))
    expect(status.replay).toMatchObject({ caught: 1, missed: 0, total: 1 })
  })

  it('a gate whose replay catches nothing stays in shadow and records the replay result', async () => {
    const db = await getTestDb()
    await seedShadowCheck(db, MISSING_OUTPUT)

    await burnIn(db)

    const record = await getEnrichment(db, SIG)
    expect(record?.status).toBe('shadow')
    const status = await getGateBurnInStatus(db, enrichStepName(SIG))
    expect(status.replay?.caught).toBe(0)
    expect(status.replay?.missed).toBe(1)
    expect(status.replay?.misses.map((m) => m.sourceTaskId)).toEqual([
      'task-origin-1',
    ])
  })

  it('the persisted replay result is readable per gate through listEnrichments', async () => {
    const db = await getTestDb()
    await seedShadowCheck(db, MISSING_OUTPUT)

    await burnIn(db)

    const listed = await listEnrichments(db)
    const entry = listed.find((e) => e.signature === SIG)
    expect(entry?.burnInParseCount).toBe(SHADOW_BURN_IN_COUNT)
    expect(entry?.burnInReplay).toMatchObject({
      caught: 0,
      missed: 1,
      total: 1,
    })
  })

  it('a check with no replayable motivating failure keeps promoting on burn-in alone', async () => {
    const db = await getTestDb()
    // No `errorOutput`: the fixture carries no evidence, so there is nothing to
    // disprove the check with and pre-ADR-0099 behaviour is preserved.
    await seedShadowCheck(db, '')

    await burnIn(db)

    const record = await getEnrichment(db, SIG)
    expect(record?.status).toBe('enforcing')
    const status = await getGateBurnInStatus(db, enrichStepName(SIG))
    expect(status.replay).toBeNull()
  })

  it('mars enrich list renders the replay verdict for a gate awaiting promotion', async () => {
    const db = await getTestDb()
    await seedShadowCheck(db, MISSING_OUTPUT)
    await burnIn(db)

    const repo = mkdtempSync(resolve(tmpdir(), 'mars-gate-replay-cli-'))
    const result = await runCommandInProcess(['enrich', 'list'], {
      store: createTaskStore(db),
      daemon: makeFakeDaemon(),
      ctx: resolveContext(repo),
    })

    expect(result.code).toBe(0)
    const line = result.out.find((l) => l.includes(SIG))
    expect(line).toBeDefined()
    expect(line).toContain('replay=0/1 caught, 1 missed')
  })
})
