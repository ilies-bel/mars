/**
 * Tests for the autonomous-recipe suppression gate (ADR-0099 / PRD
 * 1e904a61 "align self-improvement loops with weakest-valid-hypothesis
 * induction"): `RECIPE_SUPPRESSION_STREAK`, `shouldSuppressRecipe`, and the
 * `recentOutcomes` field `recipeOutcomeStats` populates for it.
 *
 * A recipe that has repeatedly failed to *help* (its most recent
 * `RECIPE_SUPPRESSION_STREAK` fired runs all resolved `taskOutcome:
 * 'did-not-help'`) must stop firing autonomously — the failure falls
 * through to the ordinary action-queue path instead. Distinct from the
 * existing op-execution `outcome` gate covered in
 * `../learned-recipes.test.ts`, and from the task-fate aggregate coverage
 * in `learned-recipes-outcome.test.ts` — this file is specifically about
 * the *consecutive-streak* suppression decision.
 *
 * Uses an in-memory PGlite backend (MARS_DB_BACKEND=pglite) and resets the
 * module singletons between tests, matching the sibling
 * `learned-recipes-outcome.test.ts` harness. Runs are inserted directly via
 * the test seam with explicit `ran_at` timestamps so ordering is
 * deterministic — real-time `logAutoRecipeRun` calls can tie on
 * millisecond-precision timestamps.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { __resetDbRegistryForTests } from '../db.js'

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
})

let currentRepoDir: string | undefined
const freshKey = (): string => {
  currentRepoDir = mkdtempSync(resolve(tmpdir(), `learned-recipes-suppression-test-${process.pid}-`))
  return currentRepoDir
}

beforeEach(async () => {
  vi.resetModules()
  process.env.MARS_REPO = freshKey()
  const { openDb } = await import('../db.js')
  const { ensureSchema } = await import('../pg-schema.js')
  const client = openDb(process.env.MARS_REPO)
  await ensureSchema(client)
})

afterEach(async () => {
  await __resetDbRegistryForTests()
  if (currentRepoDir) {
    rmSync(currentRepoDir, { recursive: true, force: true })
    currentRepoDir = undefined
  }
})

/** Load the module under test fresh, matching the reset-modules discipline above. */
const loadModule = () => import('../learned-recipes.js')

/**
 * Insert an `auto_recipe_runs` row directly with an explicit `ran_at`, so a
 * sequence of runs can be given deterministic, strictly-increasing
 * ordering — real-time inserts via `logAutoRecipeRun` can tie on
 * millisecond-precision timestamps.
 */
const insertRun = async (
  m: Awaited<ReturnType<typeof loadModule>>,
  params: {
    signature: string
    ranAt: string
    taskOutcome: 'helped' | 'did-not-help' | null
  },
): Promise<void> => {
  const client = m.__resolveStateClientForTests()
  await client.execute({
    sql: `INSERT INTO auto_recipe_runs
            (id, signature, action_op, task_id, ran_at, outcome, task_outcome, task_outcome_at)
          VALUES (?, ?, 'restart', 'task-x', ?, 'success', ?, ?)`,
    args: [
      randomUUID(),
      params.signature,
      params.ranAt,
      params.taskOutcome,
      params.taskOutcome === null ? null : params.ranAt,
    ],
  })
}

describe('RECIPE_SUPPRESSION_STREAK', () => {
  it('is 2', async () => {
    const m = await loadModule()
    expect(m.RECIPE_SUPPRESSION_STREAK).toBe(2)
  })
})

describe('shouldSuppressRecipe', () => {
  it('a recipe with no adverse history fires exactly as before (no runs at all)', async () => {
    const m = await loadModule()
    const stats = await m.recipeOutcomeStats('no-such-signature')
    expect(stats.recentOutcomes).toEqual([])
    expect(m.shouldSuppressRecipe(stats)).toBe(false)
  })

  it('a recipe with a single did-not-help outcome does not suppress — no streak yet', async () => {
    const m = await loadModule()
    const signature = 'verify:typecheck/one-strike'
    await insertRun(m, { signature, ranAt: '2026-01-01T00:00:00.000Z', taskOutcome: 'did-not-help' })

    const stats = await m.recipeOutcomeStats(signature)
    expect(stats.recentOutcomes).toEqual(['did-not-help'])
    expect(m.shouldSuppressRecipe(stats)).toBe(false)
  })

  it('a recipe that helped most recently does not suppress, even with an older did-not-help', async () => {
    const m = await loadModule()
    const signature = 'verify:typecheck/recovered'
    await insertRun(m, { signature, ranAt: '2026-01-01T00:00:00.000Z', taskOutcome: 'did-not-help' })
    await insertRun(m, { signature, ranAt: '2026-01-02T00:00:00.000Z', taskOutcome: 'helped' })

    const stats = await m.recipeOutcomeStats(signature)
    // Newest-first: the most recent run (helped) is first.
    expect(stats.recentOutcomes).toEqual(['helped', 'did-not-help'])
    expect(m.shouldSuppressRecipe(stats)).toBe(false)
  })

  it('suppresses when the last 2 consecutive recorded outcomes are did-not-help', async () => {
    const m = await loadModule()
    const signature = 'verify:typecheck/persistent-failure'
    await insertRun(m, { signature, ranAt: '2026-01-01T00:00:00.000Z', taskOutcome: 'did-not-help' })
    await insertRun(m, { signature, ranAt: '2026-01-02T00:00:00.000Z', taskOutcome: 'did-not-help' })

    const stats = await m.recipeOutcomeStats(signature)
    expect(stats.recentOutcomes).toEqual(['did-not-help', 'did-not-help'])
    expect(m.shouldSuppressRecipe(stats)).toBe(true)
  })

  it('a 2-consecutive-did-not-help streak still suppresses behind an older helped run', async () => {
    const m = await loadModule()
    const signature = 'verify:typecheck/regressed'
    // Oldest first: helped, then two consecutive did-not-help at the tail.
    await insertRun(m, { signature, ranAt: '2026-01-01T00:00:00.000Z', taskOutcome: 'helped' })
    await insertRun(m, { signature, ranAt: '2026-01-02T00:00:00.000Z', taskOutcome: 'did-not-help' })
    await insertRun(m, { signature, ranAt: '2026-01-03T00:00:00.000Z', taskOutcome: 'did-not-help' })

    const stats = await m.recipeOutcomeStats(signature)
    // recentOutcomes is capped at RECIPE_SUPPRESSION_STREAK (2) — the older
    // 'helped' run does not appear and does not dilute the streak.
    expect(stats.recentOutcomes).toEqual(['did-not-help', 'did-not-help'])
    expect(m.shouldSuppressRecipe(stats)).toBe(true)
  })

  it('does not suppress when the most recent run is still pending (unknown)', async () => {
    const m = await loadModule()
    const signature = 'verify:typecheck/pending-tail'
    await insertRun(m, { signature, ranAt: '2026-01-01T00:00:00.000Z', taskOutcome: 'did-not-help' })
    await insertRun(m, { signature, ranAt: '2026-01-02T00:00:00.000Z', taskOutcome: null })

    const stats = await m.recipeOutcomeStats(signature)
    expect(stats.recentOutcomes).toEqual([null, 'did-not-help'])
    expect(m.shouldSuppressRecipe(stats)).toBe(false)
  })
})
