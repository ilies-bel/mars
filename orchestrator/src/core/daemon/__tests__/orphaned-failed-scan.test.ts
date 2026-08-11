/**
 * Tests for raiseOrphanedFailedTaskRows — the boot-time orphaned-failed sweep.
 *
 * The invariant: every task in status='failed' must have an open action-queue
 * row so `mars action-queue list open --kind failed` reliably surfaces it.
 * Several code paths write status='failed' without raising a row (diagnose
 * Chore failures, MARS_RECOVERY_DISABLED, crash windows). The sweep is the
 * safety net that closes that gap at daemon startup.
 *
 * These tests seed tasks directly in the DB (bypassing the live code paths
 * that would normally raise rows), then invoke the sweep and assert the
 * invariant holds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-orphaned-failed-scan-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * After vi.resetModules() and MARS_REPO set, open the DB for the test repo
 * and apply the canonical schema.  The same module-level singleton that
 * raiseOrphanedFailedTaskRows() eventually reaches via resolveQueueClient()
 * uses the same identity key (the resolved .mars dir), so all reads and
 * writes land in the same in-memory PGLite instance.
 */
async function makeClient(repo: string): Promise<DbClient> {
  const { openDb } = await import('../../lib/db.js')
  const { ensureSchema } = await import('../../lib/pg-schema.js')
  const client = openDb(resolve(repo, '.mars'))
  await ensureSchema(client)
  return client
}

/** Count open action-queue rows. */
async function openRowCount(client: DbClient): Promise<number> {
  const r = await client.execute(
    `SELECT COUNT(*) AS n FROM action_queue_items WHERE status = 'open'`,
  )
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

/**
 * Return the open action-queue row whose origin_task_id matches taskId,
 * or null if no such row is open.
 */
async function openRowForOrigin(
  client: DbClient,
  taskId: string,
): Promise<{ kind: string; originTaskId: string } | null> {
  const r = await client.execute({
    sql: `SELECT kind, origin_task_id
            FROM action_queue_items
           WHERE origin_task_id = ? AND status = 'open'
           LIMIT 1`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { kind: string; origin_task_id: string }
  return { kind: row.kind, originTaskId: row.origin_task_id }
}

/**
 * Insert a minimal task row directly in the DB and force it to status='failed'
 * with the given failed_phase and failure_signature.  This bypasses the live
 * code path (which would normally raise an action-queue row) so we can test
 * the sweep in isolation.
 */
async function seedFailedTask(
  client: DbClient,
  id: string,
  opts: {
    failedPhase?: string
    failureSignature?: string
    originId?: string | null
  } = {},
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, kind, merge_mode, intent,
             failed_phase, failure_signature, origin_id,
             created_at, updated_at)
          VALUES (?, ?, 'failed', 'implement', 'auto', '',
                  ?, ?, ?,
                  NOW(), NOW())`,
    args: [
      id,
      `seed task ${id}`,
      opts.failedPhase ?? null,
      opts.failureSignature ?? null,
      opts.originId ?? null,
    ],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('raiseOrphanedFailedTaskRows — boot sweep', { timeout: 120_000 }, () => {
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

  // ── verify-phase failure ──────────────────────────────────────────────────
  it('raises an action-queue row for a failed task with failed_phase=verify', async () => {
    await seedFailedTask(client, 'task-verify-1', {
      failedPhase: 'verify',
      failureSignature: 'verify:test-suite-failed',
    })

    const { raiseOrphanedFailedTaskRows } = await import('../reconcile-orphaned-failed.js')
    const raised = await raiseOrphanedFailedTaskRows()

    expect(raised).toBe(1)
    const row = await openRowForOrigin(client, 'task-verify-1')
    expect(row).not.toBeNull()
    expect(row!.kind).toBe('failed')
    expect(row!.originTaskId).toBe('task-verify-1')
  })

  // ── code-phase failure ────────────────────────────────────────────────────
  it('raises an action-queue row for a failed task with failed_phase=code', async () => {
    await seedFailedTask(client, 'task-code-1', {
      failedPhase: 'code',
      failureSignature: 'code:max-retries-exceeded',
    })

    const { raiseOrphanedFailedTaskRows } = await import('../reconcile-orphaned-failed.js')
    const raised = await raiseOrphanedFailedTaskRows()

    expect(raised).toBe(1)
    const row = await openRowForOrigin(client, 'task-code-1')
    expect(row).not.toBeNull()
    expect(row!.kind).toBe('failed')
  })

  // ── signal-killed failure (SIGTERM / coder killed) ────────────────────────
  it('raises an action-queue row for a task killed by signal', async () => {
    await seedFailedTask(client, 'task-sigterm-1', {
      failedPhase: 'code',
      failureSignature: 'code:killed/sigterm',
    })

    const { raiseOrphanedFailedTaskRows } = await import('../reconcile-orphaned-failed.js')
    const raised = await raiseOrphanedFailedTaskRows()

    expect(raised).toBe(1)
    const row = await openRowForOrigin(client, 'task-sigterm-1')
    expect(row).not.toBeNull()
    expect(row!.kind).toBe('failed')
  })

  // ── no-op when nothing to heal ────────────────────────────────────────────
  it('returns 0 and raises no rows when no failed tasks exist', async () => {
    const { raiseOrphanedFailedTaskRows } = await import('../reconcile-orphaned-failed.js')
    const raised = await raiseOrphanedFailedTaskRows()

    expect(raised).toBe(0)
    expect(await openRowCount(client)).toBe(0)
  })

  it('returns 0 when all failed tasks already have an open action-queue row', async () => {
    await seedFailedTask(client, 'task-already-covered', {
      failedPhase: 'verify',
      failureSignature: 'verify:typecheck-failed',
    })

    const { raiseOrphanedFailedTaskRows } = await import('../reconcile-orphaned-failed.js')

    // First sweep seeds the row.
    const first = await raiseOrphanedFailedTaskRows()
    expect(first).toBe(1)

    // Second sweep: the NOT EXISTS guard in the query finds nothing because
    // an open row already exists — the task is excluded from the result set
    // before raiseActionQueueItem is even called.
    const second = await raiseOrphanedFailedTaskRows()
    expect(second).toBe(0)

    // Total open rows still exactly 1 — no duplicate was inserted.
    expect(await openRowCount(client)).toBe(1)
  })

  // ── multi-task sweep ──────────────────────────────────────────────────────
  it('heals multiple orphaned failed tasks in one sweep', async () => {
    await seedFailedTask(client, 'task-multi-a', { failedPhase: 'verify' })
    await seedFailedTask(client, 'task-multi-b', { failedPhase: 'code' })
    await seedFailedTask(client, 'task-multi-c', { failedPhase: 'setup' })

    const { raiseOrphanedFailedTaskRows } = await import('../reconcile-orphaned-failed.js')
    const raised = await raiseOrphanedFailedTaskRows()

    expect(raised).toBe(3)
    expect(await openRowCount(client)).toBe(3)
    expect(await openRowForOrigin(client, 'task-multi-a')).not.toBeNull()
    expect(await openRowForOrigin(client, 'task-multi-b')).not.toBeNull()
    expect(await openRowForOrigin(client, 'task-multi-c')).not.toBeNull()
  })

  // ── arc root: does not suppress the failed task row ───────────────────────
  // Regression: fixTaskDoneActionQueueResolver resolves rows when the fix
  // task completes.  If the fix task completes but the failed task is still
  // in 'failed' status, the resolver would have closed the previously-raised
  // row.  The sweep must detect the now-rowless failed task and re-raise.
  it('re-raises a row for a failed task whose row was resolved by a prior arc completion', async () => {
    await seedFailedTask(client, 'task-arc-origin', {
      failedPhase: 'verify',
      failureSignature: 'verify:flaky-test',
    })

    const { raiseOrphanedFailedTaskRows } = await import('../reconcile-orphaned-failed.js')

    // First sweep: row raised.
    const firstRaised = await raiseOrphanedFailedTaskRows()
    expect(firstRaised).toBe(1)
    expect(await openRowForOrigin(client, 'task-arc-origin')).not.toBeNull()

    // Simulate fixTaskDoneActionQueueResolver resolving the open row (the fix
    // task for this arc completed successfully, but the origin is still failed).
    await client.execute({
      sql: `UPDATE action_queue_items
               SET status = 'resolved',
                   resolved_at = 1000,
                   resolved_by = 'test:arc-done-simulator',
                   resolution = 'fix-task-done'
             WHERE origin_task_id = ? AND status = 'open'`,
      args: ['task-arc-origin'],
    })

    // The row is now resolved — the failed task is rowless again.
    expect(await openRowForOrigin(client, 'task-arc-origin')).toBeNull()

    // Second sweep: must re-raise a fresh row (NOT EXISTS passes again because
    // the resolved row has status='resolved', not 'open').
    const secondRaised = await raiseOrphanedFailedTaskRows()
    expect(secondRaised).toBe(1)
    expect(await openRowForOrigin(client, 'task-arc-origin')).not.toBeNull()
  })

  // ── arc member with origin_id ─────────────────────────────────────────────
  // A fix/recovery task (origin_id = arc root) that reaches 'failed' with no
  // open row: the sweep keys on COALESCE(origin_id, id), which is the arc
  // root, so the row is raised with origin_task_id = arc root.
  it('raises a row keyed on the arc root for a failed task with origin_id set', async () => {
    // Arc root (done, so it has no open row of its own)
    await client.execute({
      sql: `INSERT INTO tasks
              (id, prompt, status, kind, merge_mode, intent, origin_id, created_at, updated_at)
            VALUES ('arc-root-id', 'origin task', 'done', 'implement', 'auto', '', NULL, NOW(), NOW())`,
    })

    // Recovery task failed — origin_id points at the arc root
    await seedFailedTask(client, 'task-recovery-failed', {
      failedPhase: 'code',
      failureSignature: 'code:coder-error',
      originId: 'arc-root-id',
    })

    const { raiseOrphanedFailedTaskRows } = await import('../reconcile-orphaned-failed.js')
    const raised = await raiseOrphanedFailedTaskRows()

    expect(raised).toBe(1)
    // The row's origin_task_id must be the arc root (not the fix task itself)
    const row = await openRowForOrigin(client, 'arc-root-id')
    expect(row).not.toBeNull()
    expect(row!.kind).toBe('failed')
    expect(row!.originTaskId).toBe('arc-root-id')
  })
})
