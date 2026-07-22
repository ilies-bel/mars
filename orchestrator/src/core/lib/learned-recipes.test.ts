/**
 * Tests for the learned-recipe store (teach/unlearn/list/log).
 *
 * Uses an in-memory PGlite backend (MARS_DB_BACKEND=pglite) and resets
 * the module singletons between tests so each suite gets a fresh DB.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDbRegistryForTests } from './db.js'
import { ensureSchema } from './pg-schema.js'

beforeAll(() => {
  process.env.MARS_DB_BACKEND = 'pglite'
})

let keyCounter = 0
const freshKey = (): string => `learned-recipes-test-${process.pid}-${(keyCounter += 1)}`

// Each test gets a fresh DB via a unique key. Module-level singletons (db,
// stateClient) are reset between tests so modules pick up the fresh key.
beforeEach(async () => {
  vi.resetModules()
  process.env.MARS_REPO = freshKey()
  // Ensure schema is applied before the module under test runs.
  const { openDb } = await import('./db.js')
  const { ensureSchema: applySchema } = await import('./pg-schema.js')
  const client = openDb(process.env.MARS_REPO)
  await applySchema(client)
})

afterEach(async () => {
  await __resetDbRegistryForTests()
})

// Dynamically import the module under test so it binds to the fresh DB.
const loadModule = async () =>
  (await import('./learned-recipes.js')) as typeof import('./learned-recipes.js')

// ── teach / get / unlearn ─────────────────────────────────────────────────

describe('learned-recipes — teach / get / unlearn', () => {
  it('teachRecipe persists a recipe that getLearnedRecipe returns', async () => {
    const m = await loadModule()
    await m.teachRecipe('verify:typecheck/typecheck-type-mismatch', 'restart')
    const recipe = await m.getLearnedRecipe('verify:typecheck/typecheck-type-mismatch')
    expect(recipe).not.toBeNull()
    expect(recipe!.failureSignature).toBe('verify:typecheck/typecheck-type-mismatch')
    expect(recipe!.actionOp).toBe('restart')
    expect(typeof recipe!.learnedAt).toBe('string')
  })

  it('getLearnedRecipe returns null for unknown signature', async () => {
    const m = await loadModule()
    const recipe = await m.getLearnedRecipe('no-such/signature')
    expect(recipe).toBeNull()
  })

  it('teachRecipe upserts: re-teaching changes the op', async () => {
    const m = await loadModule()
    await m.teachRecipe('verify:typecheck/typecheck-type-mismatch', 'restart')
    await m.teachRecipe('verify:typecheck/typecheck-type-mismatch', 'purge')
    const recipe = await m.getLearnedRecipe('verify:typecheck/typecheck-type-mismatch')
    expect(recipe!.actionOp).toBe('purge')
  })

  it('unlearnRecipe removes the stored recipe', async () => {
    const m = await loadModule()
    await m.teachRecipe('verify:typecheck/typecheck-type-mismatch', 'restart')
    await m.unlearnRecipe('verify:typecheck/typecheck-type-mismatch')
    const recipe = await m.getLearnedRecipe('verify:typecheck/typecheck-type-mismatch')
    expect(recipe).toBeNull()
  })

  it('unlearnRecipe is a no-op for an unknown signature', async () => {
    const m = await loadModule()
    await expect(m.unlearnRecipe('no-such/signature')).resolves.toBeUndefined()
  })
})

// ── listLearnedRecipes ────────────────────────────────────────────────────

describe('learned-recipes — listLearnedRecipes', () => {
  it('returns an empty array when no recipes are stored', async () => {
    const m = await loadModule()
    const list = await m.listLearnedRecipes()
    expect(list).toEqual([])
  })

  it('returns all stored recipes', async () => {
    const m = await loadModule()
    await m.teachRecipe('verify:typecheck/typecheck-type-mismatch', 'restart')
    await m.teachRecipe('setup:install/install-frozen-lockfile', 'restart')
    const list = await m.listLearnedRecipes()
    expect(list).toHaveLength(2)
    const sigs = list.map((r) => r.failureSignature)
    expect(sigs).toContain('verify:typecheck/typecheck-type-mismatch')
    expect(sigs).toContain('setup:install/install-frozen-lockfile')
  })

  it('does not include un-taught recipes', async () => {
    const m = await loadModule()
    await m.teachRecipe('verify:typecheck/typecheck-type-mismatch', 'restart')
    await m.teachRecipe('setup:install/install-frozen-lockfile', 'restart')
    await m.unlearnRecipe('setup:install/install-frozen-lockfile')
    const list = await m.listLearnedRecipes()
    expect(list).toHaveLength(1)
    expect(list[0]!.failureSignature).toBe('verify:typecheck/typecheck-type-mismatch')
  })
})

// ── logAutoRecipeRun / listAutoRecipeRuns ─────────────────────────────────

describe('learned-recipes — auto-run log', () => {
  it('logAutoRecipeRun stores an entry that listAutoRecipeRuns returns', async () => {
    const m = await loadModule()
    await m.logAutoRecipeRun({
      signature: 'verify:typecheck/typecheck-type-mismatch',
      actionOp: 'restart',
      taskId: 'task-abc',
    })
    const runs = await m.listAutoRecipeRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.signature).toBe('verify:typecheck/typecheck-type-mismatch')
    expect(runs[0]!.actionOp).toBe('restart')
    expect(runs[0]!.taskId).toBe('task-abc')
    expect(typeof runs[0]!.ranAt).toBe('string')
  })

  it('logAutoRecipeRun accepts a null taskId', async () => {
    const m = await loadModule()
    await m.logAutoRecipeRun({
      signature: 'verify:typecheck/typecheck-type-mismatch',
      actionOp: 'restart',
      taskId: null,
    })
    const runs = await m.listAutoRecipeRuns()
    expect(runs[0]!.taskId).toBeNull()
  })

  it('listAutoRecipeRuns with since filters out older entries', async () => {
    const m = await loadModule()
    // Log a "past" run with a manual timestamp before we set the cursor.
    const { __resolveStateClientForTests } = await import('./learned-recipes.js')
    const client = __resolveStateClientForTests()
    await client.execute({
      sql: `INSERT INTO auto_recipe_runs (id, signature, action_op, task_id, ran_at)
            VALUES ('old-run', 'sig/old', 'restart', null, '2020-01-01T00:00:00.000Z')`,
      args: [],
    })
    // Log a fresh run.
    await m.logAutoRecipeRun({
      signature: 'sig/new',
      actionOp: 'restart',
      taskId: null,
    })
    const runs = await m.listAutoRecipeRuns({ since: '2025-01-01T00:00:00.000Z' })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.signature).toBe('sig/new')
  })

  it('listAutoRecipeRuns respects the limit option', async () => {
    const m = await loadModule()
    for (let i = 0; i < 5; i++) {
      await m.logAutoRecipeRun({ signature: `sig/${i}`, actionOp: 'restart', taskId: null })
    }
    const runs = await m.listAutoRecipeRuns({ limit: 3 })
    expect(runs).toHaveLength(3)
  })

  it('listAutoRecipeRuns returns newest-first', async () => {
    const m = await loadModule()
    const { __resolveStateClientForTests } = await import('./learned-recipes.js')
    const client = __resolveStateClientForTests()
    await client.execute({
      sql: `INSERT INTO auto_recipe_runs (id, signature, action_op, task_id, ran_at)
            VALUES ('r1', 'sig/first', 'restart', null, '2026-01-01T00:00:00.000Z'),
                   ('r2', 'sig/second', 'restart', null, '2026-01-02T00:00:00.000Z')`,
      args: [],
    })
    const runs = await m.listAutoRecipeRuns()
    expect(runs[0]!.signature).toBe('sig/second')
    expect(runs[1]!.signature).toBe('sig/first')
  })
})
