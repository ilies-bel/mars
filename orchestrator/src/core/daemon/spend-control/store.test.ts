/**
 * Unit tests for the dispatch spend control store (migration 0003).
 *
 * Verifies that:
 *   - loadSpendControl returns built-in defaults when no row exists.
 *   - upsertSpendControl then loadSpendControl round-trips correctly.
 *   - Partial patches are merged (unpatched fields retain their prior values).
 *
 * Isolation: each test uses vi.resetModules() + a fresh tmp repo with PGlite,
 * following the established pattern from merge-job-store.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// ── Helpers ───────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-spend-control-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadDeps = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const storeModule = await import('./store.js')
  const queueModule = await import('../../queue.js')
  await queueModule.migrateQueueSchema()
  return { storeModule, queueModule }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadSpendControl — defaults', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns built-in defaults when no row has been persisted', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const client = queueModule.resolveQueueClient()

    const levers = await storeModule.loadSpendControl(client)

    expect(levers.pauseThresholdPct).toBe(90)
    expect(levers.resumeThresholdPct).toBe(70)
    expect(levers.suppressRecovery).toBe(false)
    expect(levers.rampBackStepPct).toBe(10)
    expect(levers.perKindCeilings).toBeNull()
  })

  it('second call returns the same defaults (idempotent seeding)', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const client = queueModule.resolveQueueClient()

    const first = await storeModule.loadSpendControl(client)
    const second = await storeModule.loadSpendControl(client)

    expect(second).toEqual(first)
  })
})

describe('upsertSpendControl → loadSpendControl round-trip', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('upserted values are returned by a subsequent load', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const client = queueModule.resolveQueueClient()

    await storeModule.upsertSpendControl(client, {
      pauseThresholdPct: 80,
      resumeThresholdPct: 60,
      suppressRecovery: true,
      rampBackStepPct: 5,
    })

    const loaded = await storeModule.loadSpendControl(client)

    expect(loaded.pauseThresholdPct).toBe(80)
    expect(loaded.resumeThresholdPct).toBe(60)
    expect(loaded.suppressRecovery).toBe(true)
    expect(loaded.rampBackStepPct).toBe(5)
  })

  it('per-kind ceilings round-trip through jsonb', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const client = queueModule.resolveQueueClient()

    const ceilings = { coder: 4, triage: 2 }
    await storeModule.upsertSpendControl(client, { perKindCeilings: ceilings })

    const loaded = await storeModule.loadSpendControl(client)

    expect(loaded.perKindCeilings).toEqual(ceilings)
  })

  it('partial patch preserves unpatched fields', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const client = queueModule.resolveQueueClient()

    // First set a full state.
    await storeModule.upsertSpendControl(client, {
      pauseThresholdPct: 75,
      rampBackStepPct: 15,
    })

    // Then patch only one field.
    await storeModule.upsertSpendControl(client, { suppressRecovery: true })

    const loaded = await storeModule.loadSpendControl(client)

    // Patched field changed.
    expect(loaded.suppressRecovery).toBe(true)
    // Unpatched fields retain previous values.
    expect(loaded.pauseThresholdPct).toBe(75)
    expect(loaded.rampBackStepPct).toBe(15)
  })

  it('upsert returns the merged levers directly', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const client = queueModule.resolveQueueClient()

    const result = await storeModule.upsertSpendControl(client, {
      pauseThresholdPct: 85,
    })

    expect(result.pauseThresholdPct).toBe(85)
    // Other defaults remain.
    expect(result.resumeThresholdPct).toBe(70)
    expect(result.suppressRecovery).toBe(false)
  })

  it('can clear perKindCeilings by setting it to null', async () => {
    const { storeModule, queueModule } = await loadDeps(repo)
    const client = queueModule.resolveQueueClient()

    await storeModule.upsertSpendControl(client, {
      perKindCeilings: { coder: 3 },
    })
    await storeModule.upsertSpendControl(client, { perKindCeilings: null })

    const loaded = await storeModule.loadSpendControl(client)

    expect(loaded.perKindCeilings).toBeNull()
  })
})
