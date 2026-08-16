/**
 * Unit tests for the `failed` derived condition's suppression of recovery tasks
 * whose origin is still in flight.
 *
 * Invariants (from the task brief):
 *  1. A failed fix task (fix_for_task_id set) whose origin is non-terminal
 *     (queued / running / verifying / merging / blocked) raises NO action-queue row.
 *  2. A failed fix task whose origin is itself `failed` still raises exactly one row
 *     (recovery exhausted — the actionable case).
 *  3. A plain failed task (fix_for_task_id IS NULL) always raises a row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'
import { createConditionItemsSource } from '../view/derived-conditions.js'

// ── DB helpers ────────────────────────────────────────────────────────────────

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-failed-recovery-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.mars'), { recursive: true })
  return repo
}

async function makeClient(repo: string): Promise<DbClient> {
  const { openDb } = await import('../../lib/db.js')
  const { ensureSchema } = await import('../../lib/pg-schema.js')
  const client = openDb(resolve(repo, '.mars'))
  await ensureSchema(client)
  return client
}

/** Insert a minimal task row with the given status. */
async function seedTask(
  client: DbClient,
  id: string,
  status: string,
  opts: { fixForTaskId?: string } = {},
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, NOW(), NOW())`,
    args: [id, `task ${id}`, status, opts.fixForTaskId ?? null],
  })
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('deriveFailedConditions — recovery task suppression', { timeout: 60_000 }, () => {
  let repo: string
  let client: DbClient

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
    client = await makeClient(repo)
  })

  afterEach(async () => {
    await client.close()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Branch 1: in-flight origin → no row ──────────────────────────────────

  const IN_FLIGHT_STATUSES = [
    'queued',
    'running',
    'verifying',
    'merging',
    'blocked',
  ] as const

  for (const originStatus of IN_FLIGHT_STATUSES) {
    it(`suppresses the failed row when the origin is '${originStatus}'`, async () => {
      // Seed the origin task in a non-terminal status.
      await seedTask(client, 'origin-task', originStatus)
      // Seed the fix task (recovery) in failed status, pointing at the origin.
      await seedTask(client, 'fix-task', 'failed', { fixForTaskId: 'origin-task' })

      const condSource = createConditionItemsSource({ getClient: () => client })
      const rows = await condSource.derive({ kinds: new Set(['failed']) })

      // The fix task's failed row must be suppressed — origin is in flight.
      const failedIds = rows.map((r) => r.payload['taskId'])
      expect(failedIds).not.toContain('fix-task')
      expect(rows.filter((r) => r.kind === 'failed')).toHaveLength(0)
    })
  }

  // ── Branch 2: failed origin → row is kept ────────────────────────────────

  it('keeps the failed row when the origin is itself failed (recovery exhausted)', async () => {
    // Origin task reached 'failed' — recovery exhausted, this is the actionable case.
    await seedTask(client, 'origin-failed', 'failed')
    // Fix task also failed.
    await seedTask(client, 'fix-task-failed', 'failed', { fixForTaskId: 'origin-failed' })

    const condSource = createConditionItemsSource({ getClient: () => client })
    const rows = await condSource.derive({ kinds: new Set(['failed']) })

    const failedIds = rows.map((r) => r.payload['taskId'])
    // Both the origin and the fix task must appear — both are actionable.
    expect(failedIds).toContain('origin-failed')
    expect(failedIds).toContain('fix-task-failed')
    expect(rows.filter((r) => r.kind === 'failed')).toHaveLength(2)
  })

  // ── Branch 3: plain failed task → row always appears ─────────────────────

  it('always raises a row for a plain failed task (no fix_for_task_id)', async () => {
    await seedTask(client, 'plain-task', 'failed')

    const condSource = createConditionItemsSource({ getClient: () => client })
    const rows = await condSource.derive({ kinds: new Set(['failed']) })

    const failedIds = rows.map((r) => r.payload['taskId'])
    expect(failedIds).toContain('plain-task')
    expect(rows.filter((r) => r.kind === 'failed')).toHaveLength(1)
  })

  // ── Branch 4: origin done → fix task row is kept (actionable) ────────────

  it('keeps the failed row when the origin is done (fix task outlived its purpose)', async () => {
    await seedTask(client, 'origin-done', 'done')
    await seedTask(client, 'fix-task-done', 'failed', { fixForTaskId: 'origin-done' })

    const condSource = createConditionItemsSource({ getClient: () => client })
    const rows = await condSource.derive({ kinds: new Set(['failed']) })

    const failedIds = rows.map((r) => r.payload['taskId'])
    expect(failedIds).toContain('fix-task-done')
  })

})
