/**
 * Tests for the task-fate outcome layer of the learned-recipe store
 * (PRD 1e904a61 "align self-improvement loops with weakest-valid-hypothesis
 * induction"): `recordAutoRecipeTaskOutcome` and `recipeOutcomeStats`.
 *
 * Distinct from the existing `outcome` (op-execution result, resolved
 * synchronously at run time) covered in `../learned-recipes.test.ts` — this
 * file covers `taskOutcome` (did firing the recipe actually help the task),
 * resolved later once the acted-on task's fate is known.
 *
 * Uses an in-memory PGlite backend (MARS_DB_BACKEND=pglite) and resets the
 * module singletons between tests so each suite gets a fresh DB, matching
 * the sibling `learned-recipes.test.ts` harness.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { __resetDbRegistryForTests } from '../db.js'

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
})

// See learned-recipes.test.ts for why a real isolated tmpdir is required
// instead of a relative MARS_REPO key.
let currentRepoDir: string | undefined
const freshKey = (): string => {
  currentRepoDir = mkdtempSync(resolve(tmpdir(), `learned-recipes-outcome-test-${process.pid}-`))
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

describe('recordAutoRecipeTaskOutcome / recipeOutcomeStats', () => {
  it('fire → task done → stats reporting helped=1', async () => {
    const m = await loadModule()
    const signature = 'verify:typecheck/typecheck-type-mismatch'

    // Fire: a learned recipe auto-runs for a failed task.
    await m.logAutoRecipeRun({ signature, actionOp: 'restart', taskId: 'task-abc' })

    // Task done: the acted-on task's eventual fate resolves the open run.
    await m.recordAutoRecipeTaskOutcome('task-abc', 'helped')

    const stats = await m.recipeOutcomeStats(signature)
    expect(stats).toEqual({ fired: 1, helped: 1, didNotHelp: 0, unknown: 0 })

    const runs = await m.listAutoRecipeRuns({ signature })
    expect(runs[0]!.taskOutcome).toBe('helped')
    expect(runs[0]!.taskOutcomeAt).not.toBeNull()
  })

  it('a repeat failure resolves the run as did-not-help', async () => {
    const m = await loadModule()
    const signature = 'verify:typecheck/typecheck-type-mismatch'

    await m.logAutoRecipeRun({ signature, actionOp: 'restart', taskId: 'task-xyz' })
    await m.recordAutoRecipeTaskOutcome('task-xyz', 'did-not-help')

    const stats = await m.recipeOutcomeStats(signature)
    expect(stats).toEqual({ fired: 1, helped: 0, didNotHelp: 1, unknown: 0 })
  })

  it('a run whose task has not yet settled counts as unknown, not fired-and-lost', async () => {
    const m = await loadModule()
    const signature = 'verify:lint/unused-import'
    await m.logAutoRecipeRun({ signature, actionOp: 'restart', taskId: 'task-pending' })

    const stats = await m.recipeOutcomeStats(signature)
    expect(stats).toEqual({ fired: 1, helped: 0, didNotHelp: 0, unknown: 1 })
  })

  it('is a no-op for a task with no open run', async () => {
    const m = await loadModule()
    await expect(m.recordAutoRecipeTaskOutcome('no-such-task', 'helped')).resolves.toBeUndefined()
  })

  it('resolves only the most recent open run for a task with several runs', async () => {
    const m = await loadModule()
    const signature = 'verify:typecheck/typecheck-type-mismatch'

    const first = await m.logAutoRecipeRun({ signature, actionOp: 'restart', taskId: 'task-multi' })
    // First run already resolved — recordAutoRecipeTaskOutcome must skip it
    // and resolve the newer open run instead.
    await m.recordAutoRecipeTaskOutcome('task-multi', 'did-not-help')
    const second = await m.logAutoRecipeRun({ signature, actionOp: 'purge', taskId: 'task-multi' })

    await m.recordAutoRecipeTaskOutcome('task-multi', 'helped')

    const runs = await m.listAutoRecipeRuns({ signature })
    const byId = new Map(runs.map((r) => [r.id, r]))
    expect(byId.get(first)!.taskOutcome).toBe('did-not-help')
    expect(byId.get(second)!.taskOutcome).toBe('helped')

    const stats = await m.recipeOutcomeStats(signature)
    expect(stats).toEqual({ fired: 2, helped: 1, didNotHelp: 1, unknown: 0 })
  })

  it('recipeOutcomeStats for an unknown signature reports all zeros', async () => {
    const m = await loadModule()
    const stats = await m.recipeOutcomeStats('no-such-signature')
    expect(stats).toEqual({ fired: 0, helped: 0, didNotHelp: 0, unknown: 0 })
  })
})
