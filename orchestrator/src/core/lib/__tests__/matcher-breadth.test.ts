/**
 * Tests for matcher-breadth: "how many past recorded failures would this
 * matcher key have fired on?" (exact signature match vs. family match).
 *
 * Uses the in-memory PGlite backend (forced globally by test/setup-env.ts)
 * against a real per-test repo directory, mirroring promotion-ledger.test.ts:
 * `vi.resetModules()` + a fresh `MARS_REPO` per test so the module-under-test
 * and the test's own `resolveStateClient()` handle resolve to the same
 * underlying PGlite instance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../db.js'

interface MatcherBreadthMod {
  wouldHaveFiredOn: typeof import('../matcher-breadth').wouldHaveFiredOn
  wouldHaveFiredOnMany: typeof import('../matcher-breadth').wouldHaveFiredOnMany
  DEFAULT_BREADTH_WINDOW_DAYS: typeof import('../matcher-breadth').DEFAULT_BREADTH_WINDOW_DAYS
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-matcher-breadth-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Loads the module under test and its own resolved DB client against `repo`. */
const loadMod = async (repo: string): Promise<{ mb: MatcherBreadthMod; client: DbClient }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mb = (await import('../matcher-breadth.js')) as unknown as MatcherBreadthMod
  const { resolveStateClient } = await import('../../store/state-client.js')
  const { ensureSchema } = await import('../pg-schema.js')
  const client = resolveStateClient()
  await ensureSchema(client)
  return { mb, client }
}

let seq = 0
const nextId = (): string => `task-${(seq += 1)}`

/** Inserts a `failed` task with the given signature, freshly `updated_at`. */
const seedFailedTask = async (
  client: DbClient,
  failureSignature: string,
  opts: { updatedAt?: string } = {},
): Promise<void> => {
  const id = nextId()
  const updatedAt = opts.updatedAt ?? new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
          VALUES (?, ?, 'failed', ?, ?, ?)`,
    args: [id, `task ${id}`, failureSignature, updatedAt, updatedAt],
  })
}

describe('matcher-breadth', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('an unseen key returns 0 exact / 0 family', async () => {
    const { mb, client } = await loadMod(repo)
    await seedFailedTask(client, 'verify:typecheck/typecheck-type-mismatch')

    const breadth = await mb.wouldHaveFiredOn('verify:lint/lint-unused-var')

    expect(breadth.exact).toBe(0)
    expect(breadth.family).toBe(0)
    expect(breadth.windowDays).toBe(mb.DEFAULT_BREADTH_WINDOW_DAYS)
  })

  it('a key seen exactly once returns 1 exact / 1 family', async () => {
    const { mb, client } = await loadMod(repo)
    await seedFailedTask(client, 'verify:typecheck/typecheck-type-mismatch')

    const breadth = await mb.wouldHaveFiredOn('verify:typecheck/typecheck-type-mismatch')

    expect(breadth.exact).toBe(1)
    expect(breadth.family).toBe(1)
  })

  it('a family with three differently-worded members returns 1 exact / 3 family', async () => {
    const { mb, client } = await loadMod(repo)
    // Same gate ("verify:typecheck") and same error class
    // ("typecheck-type-mismatch"), different step-name wording after the
    // colon — failureSignatureFamily drops that segment, so all three land
    // in one family while only one matches the exact key verbatim.
    await seedFailedTask(client, 'verify:typecheck/typecheck-type-mismatch')
    await seedFailedTask(client, 'verify:typecheck-strict/typecheck-type-mismatch')
    await seedFailedTask(client, 'verify:typecheck-incremental/typecheck-type-mismatch')

    const breadth = await mb.wouldHaveFiredOn('verify:typecheck/typecheck-type-mismatch')

    expect(breadth.exact).toBe(1)
    expect(breadth.family).toBe(3)
  })

  it('respects a custom windowDays and excludes failures outside it', async () => {
    const { mb, client } = await loadMod(repo)
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    await seedFailedTask(client, 'verify:typecheck/typecheck-type-mismatch', { updatedAt: old })

    const breadth = await mb.wouldHaveFiredOn('verify:typecheck/typecheck-type-mismatch', {
      windowDays: 5,
    })

    expect(breadth.exact).toBe(0)
    expect(breadth.family).toBe(0)
    expect(breadth.windowDays).toBe(5)
  })

  it('wouldHaveFiredOnMany runs a single query and covers every input key', async () => {
    const { mb, client } = await loadMod(repo)
    await seedFailedTask(client, 'verify:typecheck/typecheck-type-mismatch')
    await seedFailedTask(client, 'verify:typecheck-strict/typecheck-type-mismatch')
    await seedFailedTask(client, 'verify:lint/lint-unused-var')

    const executeSpy = vi.spyOn(client, 'execute')

    const results = await mb.wouldHaveFiredOnMany([
      'verify:typecheck/typecheck-type-mismatch',
      'verify:lint/lint-unused-var',
      'never-seen/nope',
    ])

    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(results.get('verify:typecheck/typecheck-type-mismatch')).toEqual({
      exact: 1,
      family: 2,
      windowDays: mb.DEFAULT_BREADTH_WINDOW_DAYS,
    })
    expect(results.get('verify:lint/lint-unused-var')).toEqual({
      exact: 1,
      family: 1,
      windowDays: mb.DEFAULT_BREADTH_WINDOW_DAYS,
    })
    expect(results.get('never-seen/nope')).toEqual({
      exact: 0,
      family: 0,
      windowDays: mb.DEFAULT_BREADTH_WINDOW_DAYS,
    })
  })

  it('wouldHaveFiredOnMany with no keys returns an empty map without querying', async () => {
    const { mb, client } = await loadMod(repo)
    const executeSpy = vi.spyOn(client, 'execute')

    const results = await mb.wouldHaveFiredOnMany([])

    expect(results.size).toBe(0)
    expect(executeSpy).not.toHaveBeenCalled()
  })
})
