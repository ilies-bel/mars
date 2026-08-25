/**
 * Tests for the context-aware class override that reclassifies 'failed' rows
 * from 'alert' to 'notice' when a live fix/recovery task is in flight.
 *
 * Acceptance criteria (slice 6 of PRD b99b1deb):
 *  1. A failed task with an in-flight fix task → payload.recoveryInFlight=true,
 *     class='notice', humanSummary mentioning repair.
 *  2. A failed task without any fix task → payload.recoveryInFlight=false,
 *     class='alert'.
 *  3. A failed task whose fix task itself has failed (recovery exhausted) →
 *     recoveryInFlight=false, class='alert' (Mars is no longer trying).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DbClient } from '../../lib/db.js'
import { createConditionItemsSource } from '../view/derived-conditions.js'
import { buildActionQueueView, type TaskForActionQueue } from '../view/action-queue.js'

// ── DB helpers ────────────────────────────────────────────────────────────────

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-repair-override-test-'))
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

/** Minimal task record for the view store. */
const makeViewTask = (id: string): TaskForActionQueue => ({
  id,
  status: 'failed',
  prompt: `do something (${id})`,
  blockedBy: [],
  parentProposalId: null,
  failureSignature: null,
  branch: null,
  updatedAt: new Date().toISOString(),
})

// ── Test suite ────────────────────────────────────────────────────────────────

describe('derived failed row class override for in-flight recovery', { timeout: 60_000 }, () => {
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

  // ── With in-flight recovery → notice ──────────────────────────────────────

  const LIVE_STATUSES = ['queued', 'running', 'verifying', 'merging'] as const

  for (const recoveryStatus of LIVE_STATUSES) {
    it(`class='notice' and recoveryInFlight=true when fix task is '${recoveryStatus}'`, async () => {
      await seedTask(client, 'origin-failed', 'failed')
      await seedTask(client, 'fix-task', recoveryStatus, { fixForTaskId: 'origin-failed' })

      const condSource = createConditionItemsSource({ getClient: () => client })

      // 1. The derived row must carry recoveryInFlight:true in its payload.
      const derivedRows = await condSource.derive({ kinds: new Set(['failed']) })
      expect(derivedRows).toHaveLength(1)
      const derivedRow = derivedRows[0]!
      expect(derivedRow.payload['recoveryInFlight']).toBe(true)

      // 2. buildActionQueueView must classify it as 'notice' and set the
      //    notice-class humanSummary.
      const viewRows = await buildActionQueueView({
        stateStore: {
          listOpenActionQueueItems: async () => [],
          listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
        },
        taskStore: { listTasksForActionQueueItems: async () => [makeViewTask('origin-failed')] },
        repoRoot: repo,
        filter: 'open',
        conditionsSource: condSource,
      })

      const viewRow = viewRows.find((r) => r.entityId === 'origin-failed')
      expect(viewRow, 'expected a view row for origin-failed').toBeDefined()
      expect(viewRow!.class).toBe('notice')
      expect(viewRow!.humanSummary.toLowerCase()).toContain('attempting')
    })
  }

  // ── Without recovery → alert ───────────────────────────────────────────────

  it("class='alert' and recoveryInFlight=false when no fix task exists", async () => {
    await seedTask(client, 'plain-failed', 'failed')

    const condSource = createConditionItemsSource({ getClient: () => client })

    const derivedRows = await condSource.derive({ kinds: new Set(['failed']) })
    expect(derivedRows).toHaveLength(1)
    expect(derivedRows[0]!.payload['recoveryInFlight']).toBe(false)

    const viewRows = await buildActionQueueView({
      stateStore: {
        listOpenActionQueueItems: async () => [],
        listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
      },
      taskStore: { listTasksForActionQueueItems: async () => [makeViewTask('plain-failed')] },
      repoRoot: repo,
      filter: 'open',
      conditionsSource: condSource,
    })

    const viewRow = viewRows.find((r) => r.entityId === 'plain-failed')
    expect(viewRow, 'expected a view row for plain-failed').toBeDefined()
    expect(viewRow!.class).toBe('alert')
  })

  // ── Recovery exhausted (fix task itself failed) → alert ───────────────────

  it("class='alert' when fix task is also 'failed' (recovery exhausted)", async () => {
    // Both origin and fix task are in 'failed' state. The fix task's failed row
    // is shown as an alert (recovery exhausted). The origin no longer has a
    // live recovery actor, so it must also be 'alert', not 'notice'.
    await seedTask(client, 'origin-exhausted', 'failed')
    await seedTask(client, 'fix-exhausted', 'failed', { fixForTaskId: 'origin-exhausted' })

    const condSource = createConditionItemsSource({ getClient: () => client })

    const derivedRows = await condSource.derive({ kinds: new Set(['failed']) })
    const originRow = derivedRows.find((r) => r.payload['taskId'] === 'origin-exhausted')
    expect(originRow, 'expected a row for origin-exhausted').toBeDefined()
    expect(originRow!.payload['recoveryInFlight']).toBe(false)

    const viewRows = await buildActionQueueView({
      stateStore: {
        listOpenActionQueueItems: async () => [],
        listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
      },
      taskStore: { listTasksForActionQueueItems: async () => [makeViewTask('origin-exhausted')] },
      repoRoot: repo,
      filter: 'open',
      conditionsSource: condSource,
    })

    const viewRow = viewRows.find((r) => r.entityId === 'origin-exhausted')
    expect(viewRow, 'expected a view row for origin-exhausted').toBeDefined()
    expect(viewRow!.class).toBe('alert')
  })
})
