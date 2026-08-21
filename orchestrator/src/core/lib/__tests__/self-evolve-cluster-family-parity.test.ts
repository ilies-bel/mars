/**
 * Corpus parity test for the failure-cluster detector's grouping key.
 *
 * `detectFailureClusters` (self-evolve-trigger.ts) now groups on the FAMILY of
 * a `failure_signature` — `<gate>/<errorClass>`, computed by
 * {@link failureSignatureFamilySql} — instead of the raw column, so three
 * rewordings of the same gate error at different step granularities collapse
 * into one cluster of three rather than three clusters of one.
 *
 * This mirrors `__tests__/failure-signature-family.test.ts` (which asserts the
 * per-row parity between `failureSignatureFamily` (TS) and
 * `failureSignatureFamilySql` (SQL)), but at the aggregate level: it asserts
 * that GROUP BY on the SQL family expression produces the same cluster
 * counts, per family, as grouping the identical corpus in TypeScript via
 * `failureSignatureFamily`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { failureSignatureFamily, failureSignatureFamilySql } from '../failure-signature.js'

/**
 * Distinct exact signatures that collapse into fewer families — the same
 * shape the acceptance criterion describes: several rewordings (different
 * step granularities) of one gate error.
 */
const CORPUS: readonly string[] = [
  'code:commit-contract/uncommitted-changes',
  'code:another-step/uncommitted-changes',
  'code/uncommitted-changes',
  'verify:has-diff/no-commits-ahead',
  'verify:worktree-hygiene/no-commits-ahead',
  'verify/timeout',
  'verify/timeout',
  'merge:vcs-supervisor-aborted/rebase-dirty-worktree',
  'unknown/unclassified',
]

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-cluster-family-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('failure cluster family grouping — SQL/TS parity', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('SQL GROUP BY on the family expression matches TS grouping over the same corpus', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const q = await import('../../queue.js')
    await q.ensureQueueSchema()
    const client = q.resolveQueueClient()

    const familyExpr = failureSignatureFamilySql('sig')
    const placeholders = CORPUS.map(() => '(?)').join(', ')
    const rows = await client.execute({
      sql: `SELECT ${familyExpr} AS family, COUNT(*) AS cnt
              FROM (VALUES ${placeholders}) AS t(sig)
             GROUP BY ${familyExpr}`,
      args: [...CORPUS],
    })

    const sqlFamilies = new Map<string, number>()
    for (const row of rows.rows as Array<{ family: string; cnt: number }>) {
      sqlFamilies.set(row.family, row.cnt)
    }

    const tsFamilies = new Map<string, number>()
    for (const sig of CORPUS) {
      const family = failureSignatureFamily(sig)
      tsFamilies.set(family, (tsFamilies.get(family) ?? 0) + 1)
    }

    expect(sqlFamilies).toEqual(tsFamilies)
  })

  it('collapses three same-family rewordings into one cluster of three via runReflectRecommendedDetector', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo

    // Same store seam discipline as reflect-recommended-detector.test.ts:
    // everything is imported after vi.resetModules() so the test shares the
    // module-scoped openDb registry with the module under test.
    const { resolveStateClient } = await import('../../store/state-client.js')
    const { createTaskStore } = await import('../../store/task-store.js')
    const store = createTaskStore(resolveStateClient())
    const { runReflectRecommendedDetector } = await import('../self-evolve-trigger.js')

    // Three DIFFERENT exact failure_signature strings that share one family
    // (`code/uncommitted-changes`) — a raw-column GROUP BY would see each as
    // its own singleton cluster and never reach FAILURE_CLUSTER_MIN (3).
    const insertFailedTask = async (id: string, failureSignature: string): Promise<void> => {
      const now = new Date().toISOString()
      await store.execute({
        sql: `INSERT INTO tasks (id, prompt, status, failure_signature, created_at, updated_at)
              VALUES (?, ?, 'failed', ?, ?, ?)`,
        args: [id, `task ${id}`, failureSignature, now, now],
      })
    }
    await insertFailedTask('task-fam-1', 'code:commit-contract/uncommitted-changes')
    await insertFailedTask('task-fam-2', 'code:another-step/uncommitted-changes')
    await insertFailedTask('task-fam-3', 'code/uncommitted-changes')

    const result = await runReflectRecommendedDetector({ store })

    expect(result.raised).toBe(true)
    const cluster = result.evidence?.failureClusters.find((c) => c.family === 'code/uncommitted-changes')
    expect(cluster).toBeDefined()
    expect(cluster?.count).toBeGreaterThanOrEqual(3)
  })
})
