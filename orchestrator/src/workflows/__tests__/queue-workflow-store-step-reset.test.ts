/**
 * Regression tests for `clearStepsFromCheckpoint` in queue-workflow-store.ts.
 *
 * Verifies the observable state of workflow_step_runs after clearing:
 *
 *   1. Returns `null` when the named step has no checkpoint (step not found).
 *   2. Returns the cleared step names (the target and all downstream steps).
 *   3. The target step and every downstream checkpoint are deleted from the DB.
 *   4. Steps before the target step are NOT touched.
 *   5. Idempotent: a second call for the same step on the same run returns null
 *      (already deleted).
 *
 * Uses the same repo-provisioned PGlite DB as other queue-adjacent tests
 * (migrateQueueSchema + resolveQueueClient). The `clearStepsFromCheckpoint`
 * function is exercised with an explicit client so the test controls the DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-wf-store-reset-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

/**
 * Seed `workflow_step_runs` directly so we don't need a real workflow run.
 * Each entry gets a stable `seq` value to control ordering.
 */
const seedSteps = async (
  client: Awaited<ReturnType<typeof import('../../core/queue').resolveQueueClient>>,
  runId: string,
  steps: Array<{ name: string; seq: number; status?: string }>,
): Promise<void> => {
  for (const s of steps) {
    await client.execute({
      sql: `INSERT INTO workflow_step_runs
              (run_id, step_name, status, sha, started_at, finished_at,
               attempt, summary, error_summary, transcript_key, result_json, seq)
            VALUES (?, ?, ?, NULL, ?, NULL, 1, NULL, NULL, NULL, NULL, ?)`,
      args: [runId, s.name, s.status ?? 'completed', Date.now(), s.seq],
    })
  }
}

const listStepNames = async (
  client: Awaited<ReturnType<typeof import('../../core/queue').resolveQueueClient>>,
  runId: string,
): Promise<string[]> => {
  const r = await client.execute({
    sql: 'SELECT step_name FROM workflow_step_runs WHERE run_id = ? ORDER BY seq ASC',
    args: [runId],
  })
  return (r.rows as unknown as { step_name: string }[]).map((row) => row.step_name)
}

describe('clearStepsFromCheckpoint', () => {
  it('returns null when the named step has no checkpoint for this run', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../../core/queue')
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const { clearStepsFromCheckpoint } = await import('../queue-workflow-store')

    const result = await clearStepsFromCheckpoint('run-xyz', 'setup-worktree', client)

    expect(result).toBeNull()
  })

  it('returns the cleared step names including the target', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../../core/queue')
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const { clearStepsFromCheckpoint } = await import('../queue-workflow-store')

    const runId = 'run-abc'
    await seedSteps(client, runId, [
      { name: 'setup-worktree', seq: 0 },
      { name: 'run-claude-code', seq: 1 },
      { name: 'verify', seq: 2 },
    ])

    const cleared = await clearStepsFromCheckpoint(runId, 'run-claude-code', client)

    expect(cleared).toEqual(['run-claude-code', 'verify'])
  })

  it('deletes the target step and all downstream steps from the DB', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../../core/queue')
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const { clearStepsFromCheckpoint } = await import('../queue-workflow-store')

    const runId = 'run-def'
    await seedSteps(client, runId, [
      { name: 'setup-worktree', seq: 0 },
      { name: 'run-claude-code', seq: 1 },
      { name: 'verify', seq: 2 },
      { name: 'merge', seq: 3 },
    ])

    await clearStepsFromCheckpoint(runId, 'verify', client)

    const remaining = await listStepNames(client, runId)
    expect(remaining).toEqual(['setup-worktree', 'run-claude-code'])
  })

  it('does NOT touch steps before the target', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../../core/queue')
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const { clearStepsFromCheckpoint } = await import('../queue-workflow-store')

    const runId = 'run-ghi'
    await seedSteps(client, runId, [
      { name: 'setup-worktree', seq: 0 },
      { name: 'run-claude-code', seq: 1 },
      { name: 'verify', seq: 2 },
    ])

    await clearStepsFromCheckpoint(runId, 'run-claude-code', client)

    const remaining = await listStepNames(client, runId)
    // Only setup-worktree should survive
    expect(remaining).toEqual(['setup-worktree'])
  })

  it('resetting to the first step clears all checkpoints', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../../core/queue')
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const { clearStepsFromCheckpoint } = await import('../queue-workflow-store')

    const runId = 'run-jkl'
    await seedSteps(client, runId, [
      { name: 'setup-worktree', seq: 0 },
      { name: 'run-claude-code', seq: 1 },
      { name: 'verify', seq: 2 },
    ])

    const cleared = await clearStepsFromCheckpoint(runId, 'setup-worktree', client)

    expect(cleared).toEqual(['setup-worktree', 'run-claude-code', 'verify'])
    const remaining = await listStepNames(client, runId)
    expect(remaining).toHaveLength(0)
  })

  it('is idempotent: a second clear of the same step returns null (already gone)', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../../core/queue')
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const { clearStepsFromCheckpoint } = await import('../queue-workflow-store')

    const runId = 'run-mno'
    await seedSteps(client, runId, [
      { name: 'setup-worktree', seq: 0 },
      { name: 'verify', seq: 1 },
    ])

    const first = await clearStepsFromCheckpoint(runId, 'verify', client)
    expect(first).toEqual(['verify'])

    // Second call: 'verify' row is gone → null (not found)
    const second = await clearStepsFromCheckpoint(runId, 'verify', client)
    expect(second).toBeNull()
  })

  it('does not touch other runs with the same step names', async () => {
    const { migrateQueueSchema, resolveQueueClient } = await import('../../core/queue')
    await migrateQueueSchema()
    const client = resolveQueueClient()
    const { clearStepsFromCheckpoint } = await import('../queue-workflow-store')

    const runA = 'run-pqr'
    const runB = 'run-stu'
    await seedSteps(client, runA, [
      { name: 'setup-worktree', seq: 0 },
      { name: 'verify', seq: 1 },
    ])
    await seedSteps(client, runB, [
      { name: 'setup-worktree', seq: 0 },
      { name: 'verify', seq: 1 },
    ])

    await clearStepsFromCheckpoint(runA, 'verify', client)

    // runA: 'verify' is gone, 'setup-worktree' survives
    expect(await listStepNames(client, runA)).toEqual(['setup-worktree'])
    // runB: untouched
    expect(await listStepNames(client, runB)).toEqual(['setup-worktree', 'verify'])
  })
})
