/**
 * Tests for the "stop asking me that" dismissal verbs on suggestion-kind
 * action-queue items (DEC-19).
 *
 * Covers two paths:
 *
 *   1. reflect-recommended: `recordNoticeDismissal('reflect-recommended')` →
 *      `isNoticeDismissed('reflect-recommended')` returns true, and
 *      `runReflectRecommendedDetector` returns `skipReason: 'dismissed'` when
 *      evidence is worthy.
 *
 *   2. scorer-suggested (sanity): `dismissScorer` → same fingerprint is
 *      'already-triaged' on re-suggest, confirming the existing permanent-
 *      dismiss semantic that the new `/view/scorer-dismiss` route exposes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DomainTaskStore } from '../../store/task-store-default'

// ─── module interface types ───────────────────────────────────────────────────

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface ActionQueueModule {
  isNoticeDismissed: typeof import('../../lib/action-queue').isNoticeDismissed
  recordNoticeDismissal: typeof import('../../lib/action-queue').recordNoticeDismissal
}

interface SelfEvolveTriggerModule {
  runReflectRecommendedDetector: typeof import('../../lib/self-evolve-trigger').runReflectRecommendedDetector
}

interface ScorersModule {
  initScorers: typeof import('../../scorers').initScorers
  suggestScorer: typeof import('../../scorers').suggestScorer
  dismissScorer: typeof import('../../scorers').dismissScorer
}

// ─── shared setup ────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-dismiss-action-queue-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// ─── reflect-recommended permanent dismissal ──────────────────────────────────

describe('reflect-recommended permanent dismissal', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('recordNoticeDismissal + isNoticeDismissed round-trip', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { migrateQueueSchema } = (await import('../../queue')) as unknown as QueueModule
    await migrateQueueSchema()
    const { recordNoticeDismissal, isNoticeDismissed } =
      (await import('../../lib/action-queue')) as unknown as ActionQueueModule

    // Nothing recorded yet.
    expect(await isNoticeDismissed('reflect-recommended')).toBe(false)

    // Write a dismissal record.
    await recordNoticeDismissal('reflect-recommended', 'test:stop-asking-reflect')

    // Now it's dismissed.
    expect(await isNoticeDismissed('reflect-recommended')).toBe(true)
  })

  it('dismissal is per-key: dismissing one key does not affect another', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { migrateQueueSchema } = (await import('../../queue')) as unknown as QueueModule
    await migrateQueueSchema()
    const { recordNoticeDismissal, isNoticeDismissed } =
      (await import('../../lib/action-queue')) as unknown as ActionQueueModule

    await recordNoticeDismissal('reflect-recommended', 'test')
    expect(await isNoticeDismissed('reflect-recommended')).toBe(true)
    expect(await isNoticeDismissed('spend-control-notice')).toBe(false)
  })

  it('recordNoticeDismissal is idempotent (upsert)', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { migrateQueueSchema } = (await import('../../queue')) as unknown as QueueModule
    await migrateQueueSchema()
    const { recordNoticeDismissal, isNoticeDismissed } =
      (await import('../../lib/action-queue')) as unknown as ActionQueueModule

    await recordNoticeDismissal('reflect-recommended', 'first-call')
    await recordNoticeDismissal('reflect-recommended', 'second-call') // must not throw
    expect(await isNoticeDismissed('reflect-recommended')).toBe(true)
  })

  it(
    'runReflectRecommendedDetector returns skipReason=dismissed when evidence is worthy',
    async () => {
      vi.resetModules()
      process.env.MARS_REPO = repo
      const { migrateQueueSchema } = (await import('../../queue')) as unknown as QueueModule
      await migrateQueueSchema()
      const { recordNoticeDismissal } =
        (await import('../../lib/action-queue')) as unknown as ActionQueueModule
      const { runReflectRecommendedDetector } =
        (await import('../../lib/self-evolve-trigger')) as unknown as SelfEvolveTriggerModule

      // Write the permanent dismissal record.
      await recordNoticeDismissal('reflect-recommended', 'test:stop-asking-reflect')

      // Inject a minimal mock store that makes evaluateWorthiness see a failure
      // cluster (detector 2), pushing worthy → true so the dismissed guard fires.
      // All other queries return empty rows (no KPI drift, no token spike).
      const worthyStore = {
        query: async ({ sql }: { sql: string; args: unknown[] }) => {
          // Detect the failure-cluster query by its HAVING COUNT(*) >= ? clause
          // and return one cluster above the threshold.
          if (
            typeof sql === 'string' &&
            sql.includes('failure_signature') &&
            sql.toUpperCase().includes('HAVING')
          ) {
            return { rows: [{ family: 'code/verify-failed', cnt: 5 }] }
          }
          // All other store queries (snapshots, token spend, cooldown, etc.)
          // return empty so they don't interfere.
          return { rows: [] }
        },
      } as unknown as DomainTaskStore

      const result = await runReflectRecommendedDetector({ store: worthyStore })

      expect(result.raised).toBe(false)
      expect(result.skipReason).toBe('dismissed')
      expect(result.rowId).toBeNull()
    },
  )

  it(
    'runReflectRecommendedDetector raises when no dismissal and evidence is worthy',
    async () => {
      vi.resetModules()
      process.env.MARS_REPO = repo
      const { migrateQueueSchema } = (await import('../../queue')) as unknown as QueueModule
      await migrateQueueSchema()
      const { runReflectRecommendedDetector } =
        (await import('../../lib/self-evolve-trigger')) as unknown as SelfEvolveTriggerModule

      // Same worthy store, but no dismissal written → should raise.
      const worthyStore = {
        query: async ({ sql }: { sql: string; args: unknown[] }) => {
          if (
            typeof sql === 'string' &&
            sql.includes('failure_signature') &&
            sql.toUpperCase().includes('HAVING')
          ) {
            return { rows: [{ family: 'code/verify-failed', cnt: 5 }] }
          }
          return { rows: [] }
        },
      } as unknown as DomainTaskStore

      const result = await runReflectRecommendedDetector({ store: worthyStore })

      // With evidence but no dismissal, the detector raises a row.
      expect(result.raised).toBe(true)
      expect(result.skipReason).toBeNull()
      expect(result.rowId).not.toBeNull()
    },
  )
})

// ─── scorer-suggested permanent dismissal ────────────────────────────────────

describe('scorer-suggested permanent dismissal (stop-asking-me-that semantic)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const suggestInput = {
    workflow: 'task',
    title: 'Diff minimality',
    rubric:
      'Grade how tightly the diff is scoped to the goal, from 0 to 1.',
    originArcId: 'arc-dismiss-aq-001',
    reportPath: null,
    evidence: ['task mars-xyz event 3: verify passed with 0 tests run'],
    confidence: 0.7,
  } as const

  it('dismissScorer prevents re-suggestion (already-triaged)', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { migrateQueueSchema } = (await import('../../queue')) as unknown as QueueModule
    await migrateQueueSchema()
    const { initScorers, suggestScorer, dismissScorer } =
      (await import('../../scorers')) as unknown as ScorersModule
    await initScorers()

    // Suggest then dismiss.
    const { scorer } = await suggestScorer({ ...suggestInput })
    await dismissScorer(scorer.id)

    // Same fingerprint re-suggested — should be 'already-triaged', not 'added'.
    const second = await suggestScorer({ ...suggestInput })
    expect(second.outcome).toBe('already-triaged')
  })

  it('dismissScorer allows a different fingerprint to be suggested normally', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { migrateQueueSchema } = (await import('../../queue')) as unknown as QueueModule
    await migrateQueueSchema()
    const { initScorers, suggestScorer, dismissScorer } =
      (await import('../../scorers')) as unknown as ScorersModule
    await initScorers()

    const { scorer } = await suggestScorer({ ...suggestInput })
    await dismissScorer(scorer.id)

    // A genuinely different scorer — different title = different fingerprint.
    const different = await suggestScorer({
      ...suggestInput,
      title: 'Completely different metric',
      evidence: ['task mars-abc: unrelated signal'],
    })
    expect(different.outcome).toBe('created')
  })
})
