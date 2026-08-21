/**
 * Tests for matcher breadth (ADR-0099) — how many PAST failures a learned
 * recipe's signature would have matched, exactly and by family.
 *
 * Coverage:
 *  - `wouldHaveFiredOnMany` (matcher-breadth.ts): batched exact/family counts
 *    over seeded `tasks` rows, including the zero-match and no-input cases.
 *  - `listLearnedRecipes()` (learned-recipes.ts): a recipe listed after two
 *    same-family (but not identical) historic failures reports
 *    `breadth.family >= 2`, proving the field surfaces end-to-end through
 *    the store, not just the lower-level helper.
 *
 * Pattern mirrors `storm-evidence.test.ts`: seed rows via the queue module's
 * `enqueueTask`/`updateTask`, then read back through the module under test —
 * both bind to the same DB target (`resolveStateClient` and
 * `resolveQueueClient` share one pool/PGlite instance per target, see
 * `state-client.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  ensureQueueSchema: typeof import('../../queue').ensureQueueSchema
}

interface MatcherBreadthModule {
  wouldHaveFiredOnMany: typeof import('../matcher-breadth').wouldHaveFiredOnMany
}

interface LearnedRecipesModule {
  teachRecipe: typeof import('../learned-recipes').teachRecipe
  listLearnedRecipes: typeof import('../learned-recipes').listLearnedRecipes
}

/** Two signatures naming the same failure at different step granularities. */
const FINE_SIGNATURE = 'verify:typecheck/typecheck-type-mismatch'
const FAMILY_SIGNATURE = 'verify/typecheck-type-mismatch'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-matcher-breadth-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; mb: MatcherBreadthModule; lr: LearnedRecipesModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const mb = (await import('../matcher-breadth')) as unknown as MatcherBreadthModule
  const lr = (await import('../learned-recipes')) as unknown as LearnedRecipesModule
  return { q, mb, lr }
}

/** Seed one failed task carrying `signature` on both signature columns. */
const seedFailedTask = async (q: QueueModule, signature: string): Promise<string> => {
  const task = await q.enqueueTask('matcher-breadth fixture', undefined, { skipTriage: true })
  await q.updateTask(task.id, {
    status: 'failed',
    error: `fixture failure: ${signature}`,
    failedPhase: 'verify',
    failureReason: signature,
    failureSignature: signature,
    failureReasonCode: signature,
  })
  return task.id
}

describe('wouldHaveFiredOnMany', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns an empty map for an empty input', async () => {
    const { mb } = await loadModules(repo)
    const result = await mb.wouldHaveFiredOnMany([])
    expect(result.size).toBe(0)
  })

  it('reports zero exact and zero family breadth for a signature with no past matches', async () => {
    const { mb } = await loadModules(repo)
    const result = await mb.wouldHaveFiredOnMany(['no-such/signature'])
    expect(result.get('no-such/signature')).toEqual({ exact: 0, family: 0, windowDays: 30 })
  })

  it('counts exact matches and family matches separately, in one batched call', async () => {
    const { q, mb } = await loadModules(repo)
    await seedFailedTask(q, FINE_SIGNATURE)
    await seedFailedTask(q, FINE_SIGNATURE)
    // Same family (same gate, same error class), different step granularity —
    // must count toward `family` but not `exact`.
    await seedFailedTask(q, FAMILY_SIGNATURE)
    // A different error class in the same gate — must not count at all.
    await seedFailedTask(q, 'verify:typecheck/unrelated-error')

    const result = await mb.wouldHaveFiredOnMany([FINE_SIGNATURE])
    expect(result.get(FINE_SIGNATURE)).toEqual({ exact: 2, family: 3, windowDays: 30 })
  })

  it('resolves multiple signatures in a single call', async () => {
    const { q, mb } = await loadModules(repo)
    await seedFailedTask(q, FINE_SIGNATURE)
    await seedFailedTask(q, 'setup:install/install-frozen-lockfile')

    const result = await mb.wouldHaveFiredOnMany([
      FINE_SIGNATURE,
      'setup:install/install-frozen-lockfile',
      'no-such/signature',
    ])
    expect(result.get(FINE_SIGNATURE)).toEqual({ exact: 1, family: 1, windowDays: 30 })
    expect(result.get('setup:install/install-frozen-lockfile')).toEqual({
      exact: 1,
      family: 1,
      windowDays: 30,
    })
    expect(result.get('no-such/signature')).toEqual({ exact: 0, family: 0, windowDays: 30 })
  })
})

describe('listLearnedRecipes — breadth end-to-end', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('a recipe listed after two same-family failures reports family >= 2', async () => {
    const { q, lr } = await loadModules(repo)
    await seedFailedTask(q, FINE_SIGNATURE)
    await seedFailedTask(q, FAMILY_SIGNATURE)
    await lr.teachRecipe(FINE_SIGNATURE, 'restart')

    const list = await lr.listLearnedRecipes()
    const recipe = list.find((r) => r.failureSignature === FINE_SIGNATURE)
    expect(recipe).toBeDefined()
    expect(recipe!.breadth).toBeDefined()
    expect(recipe!.breadth!.family).toBeGreaterThanOrEqual(2)
  })

  it('a recipe taught from a single unique failure reports narrow breadth', async () => {
    const { q, lr } = await loadModules(repo)
    await seedFailedTask(q, FINE_SIGNATURE)
    await lr.teachRecipe(FINE_SIGNATURE, 'restart')

    const list = await lr.listLearnedRecipes()
    const recipe = list.find((r) => r.failureSignature === FINE_SIGNATURE)
    expect(recipe!.breadth).toEqual({ exact: 1, family: 1, windowDays: 30 })
  })
})
