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

  // ── The payload/recipe contract ──────────────────────────────────────────

  describe('diagnostic payload', () => {
    /**
     * The derived row and the `failed` recipe are two halves of one contract,
     * joined only by string keys. They drifted: the row emitted `signature`
     * while the recipe read `failureSignature`, and branch/worktree/error were
     * never emitted at all. Nothing failed — the recipe just rendered empty
     * strings, so every failed alert in the queue said a task broke and
     * nothing about how. These tests pin the join.
     */
    it('carries the diagnostics the failed recipe reads', async () => {
      await client.execute({
        sql: `INSERT INTO tasks
                (id, prompt, status, failure_signature, failure_reason_code,
                 branch, worktree_path, error, created_at, updated_at)
              VALUES (?, ?, 'failed', ?, ?, ?, ?, ?, NOW(), NOW())`,
        args: [
          'diag-task',
          'task diag-task',
          'code:context-exhausted/unclassified',
          'code:context-exhausted/unclassified',
          'task/diag-task',
          '/repo/.mars/worktrees/diag-task',
          'context budget exhausted (maxContextTokens) mid-code',
        ],
      })

      const condSource = createConditionItemsSource({ getClient: () => client })
      const rows = await condSource.derive({ kinds: new Set(['failed']) })
      const row = rows.find((r) => r.payload['taskId'] === 'diag-task')
      expect(row).toBeDefined()

      const { lookupRecipe } = await import('../../lib/action-queue-recipes.js')
      const detail = lookupRecipe('failed').humanDetail({
        kind: 'failed',
        entityId: 'diag-task',
        payload: row!.payload,
        context: row!.context,
        title: '',
        body: '',
        raisedAt: new Date(row!.raisedAt).toISOString(),
      })

      expect(detail['failureSignature']).toBe('code:context-exhausted/unclassified')
      expect(detail['branch']).toBe('task/diag-task')
      expect(detail['worktree']).toBe('/repo/.mars/worktrees/diag-task')
      expect(detail['errorExcerpt']).toContain('context budget exhausted')
    })

    it('clips a captured-output blob rather than carrying it whole', async () => {
      // `tasks.error` holds full step output — one live row carries a 2000-char
      // vitest dump. A queue row is not a transcript viewer.
      await client.execute({
        sql: `INSERT INTO tasks (id, prompt, status, error, created_at, updated_at)
              VALUES (?, ?, 'failed', ?, NOW(), NOW())`,
        args: ['blob-task', 'task blob-task', 'x'.repeat(5000)],
      })

      const condSource = createConditionItemsSource({ getClient: () => client })
      const rows = await condSource.derive({ kinds: new Set(['failed']) })
      const excerpt = rows.find((r) => r.payload['taskId'] === 'blob-task')!
        .payload['errorExcerpt'] as string

      expect(excerpt.length).toBeLessThan(700)
      expect(excerpt.endsWith('…')).toBe(true)
    })
  })
})
