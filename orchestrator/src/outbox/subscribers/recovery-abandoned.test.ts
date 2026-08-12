/**
 * recovery-abandoned outbox subscriber — behaviour tests.
 *
 * The subscriber fires on `task.terminal { reason: 'dropped' }` events and
 * raises a `recovery-abandoned` action-queue item against the origin task when
 * the dropped task is a fix task (fixForTaskId IS NOT NULL). Non-fix drops are
 * ignored.
 *
 * Test setup mirrors the pattern in recovery-spawn.test.ts: a real git repo is
 * created in a temp directory, MARS_REPO is set to point to it, and
 * vi.resetModules() ensures every singleton (DB client, context cache, etc.)
 * is fresh for each test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import type { DbClient } from '../../core/lib/db.js'
import type { EventName, EventPayload } from '../../bus/events.js'

// ---------------------------------------------------------------------------
// Module type shims (loaded via vi.resetModules() isolation)
// ---------------------------------------------------------------------------

interface QueueModule {
  enqueueTask: typeof import('../../core/queue').enqueueTask
  resolveQueueClient: typeof import('../../core/queue').resolveQueueClient
  ensureQueueSchema: typeof import('../../core/queue').ensureQueueSchema
}

interface RecoveryAbandonedModule {
  RECOVERY_ABANDONED_SUBSCRIBER: string
  ensureRecoveryAbandonedSubscriber: typeof import('./recovery-abandoned').ensureRecoveryAbandonedSubscriber
  drainRecoveryAbandoned: typeof import('./recovery-abandoned').drainRecoveryAbandoned
}

interface PublisherModule {
  publishWithRetry: typeof import('../../bus/publisher').publishWithRetry
}

interface Loaded {
  q: QueueModule
  ra: RecoveryAbandonedModule
  pub: PublisherModule
  client: DbClient
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupRepo(): string {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-recovery-abandoned-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@mars.local'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Mars Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'recovery-abandoned fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

async function loadModules(repo: string): Promise<Loaded> {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../core/queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const ra = (await import('./recovery-abandoned')) as unknown as RecoveryAbandonedModule
  const pub = (await import('../../bus/publisher')) as unknown as PublisherModule
  return { q, ra, pub, client: q.resolveQueueClient() }
}

async function publish<T extends EventName>(
  pub: PublisherModule,
  client: DbClient,
  type: T,
  payload: EventPayload<T>,
): Promise<void> {
  await pub.publishWithRetry(client, type, payload)
}

/**
 * Insert a minimal fix-task row directly, bypassing the full recovery-spawn
 * machinery. The subscriber only needs the `fixForTaskId` pointer to be set —
 * it does not care about recovery-spawn invariants.
 *
 * The `fix_for_task_id` FK requires the origin to already be in the tasks
 * table, so always pass an `originId` that was inserted first.
 */
async function insertFixTask(
  client: DbClient,
  fixTaskId: string,
  originId: string,
): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, fix_for_task_id, kind, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [fixTaskId, 'fix: recovery task', 'dropped', originId, 'fix', now, now],
  })
}

/** Count open action-queue rows. */
async function openRowCount(client: DbClient): Promise<number> {
  const r = await client.execute(
    `SELECT COUNT(*) AS n FROM action_queue_items WHERE status = 'open'`,
  )
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

/** Return the first open action-queue row for `originTaskId`, or null. */
async function openRowForOrigin(
  client: DbClient,
  originTaskId: string,
): Promise<{ kind: string; title: string; body: string } | null> {
  const r = await client.execute({
    sql: `SELECT kind, title, body
            FROM action_queue_items
           WHERE origin_task_id = ? AND status = 'open'
           LIMIT 1`,
    args: [originTaskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as { kind: string; title: string; body: string }
  return { kind: row.kind, title: row.title, body: row.body }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recovery-abandoned outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises exactly one action-queue row against the origin when a fix task is dropped', async () => {
    const { q, ra, pub, client } = await loadModules(repo)

    // Create origin task.
    const origin = await q.enqueueTask('implement feature X', undefined, { skipTriage: true })

    // Insert a fix task referencing the origin directly in the DB so we don't
    // have to exercise the full recovery-spawn machinery.
    const fixTaskId = 'fix-task-alpha'
    await insertFixTask(client, fixTaskId, origin.id)

    // Register subscriber AFTER setup so the cursor starts past setup events.
    await ra.ensureRecoveryAbandonedSubscriber(client)

    // Publish the terminal event that the daemon emits when a task is dropped.
    await publish(pub, client, 'task.terminal', { taskId: fixTaskId, reason: 'dropped' })

    const { processed } = await ra.drainRecoveryAbandoned(client)

    expect(processed).toBe(1)
    expect(await openRowCount(client)).toBe(1)

    const row = await openRowForOrigin(client, origin.id)
    expect(row).not.toBeNull()
    expect(row!.kind).toBe('recovery-abandoned')
  })

  it('raises zero action-queue rows when a non-fix task is dropped', async () => {
    const { q, ra, pub, client } = await loadModules(repo)

    // A plain task (no fix_for_task_id).
    const plainTask = await q.enqueueTask('plain task', undefined, { skipTriage: true })

    await ra.ensureRecoveryAbandonedSubscriber(client)

    // Emit a terminal dropped event for the non-fix task.
    await publish(pub, client, 'task.terminal', { taskId: plainTask.id, reason: 'dropped' })

    const { processed } = await ra.drainRecoveryAbandoned(client)

    // Non-fix drops are ignored.
    expect(processed).toBe(0)
    expect(await openRowCount(client)).toBe(0)
  })

  it('row body contains both `mars continue` and `mars restart` with the origin id', async () => {
    const { q, ra, pub, client } = await loadModules(repo)

    const origin = await q.enqueueTask('implement feature Y', undefined, { skipTriage: true })
    const fixTaskId = 'fix-task-beta'
    await insertFixTask(client, fixTaskId, origin.id)

    await ra.ensureRecoveryAbandonedSubscriber(client)
    await publish(pub, client, 'task.terminal', { taskId: fixTaskId, reason: 'dropped' })
    await ra.drainRecoveryAbandoned(client)

    const row = await openRowForOrigin(client, origin.id)
    expect(row).not.toBeNull()
    expect(row!.body).toContain(`mars continue ${origin.id}`)
    expect(row!.body).toContain(`mars restart ${origin.id}`)
  })

  it('ignores task.terminal events with reason other than dropped', async () => {
    const { q, ra, pub, client } = await loadModules(repo)

    const origin = await q.enqueueTask('implement feature Z', undefined, { skipTriage: true })
    const fixTaskId = 'fix-task-gamma'
    await insertFixTask(client, fixTaskId, origin.id)

    await ra.ensureRecoveryAbandonedSubscriber(client)

    // Emit 'done' and 'failed' terminal events — both must be ignored.
    await publish(pub, client, 'task.terminal', { taskId: fixTaskId, reason: 'done' })
    await publish(pub, client, 'task.terminal', { taskId: origin.id, reason: 'failed' })

    const { processed } = await ra.drainRecoveryAbandoned(client)

    expect(processed).toBe(0)
    expect(await openRowCount(client)).toBe(0)
  })

  it('is idempotent: replaying the same event does not raise a second row', async () => {
    const { q, ra, pub, client } = await loadModules(repo)

    const origin = await q.enqueueTask('implement feature W', undefined, { skipTriage: true })
    const fixTaskId = 'fix-task-delta'
    await insertFixTask(client, fixTaskId, origin.id)

    await ra.ensureRecoveryAbandonedSubscriber(client)
    await publish(pub, client, 'task.terminal', { taskId: fixTaskId, reason: 'dropped' })

    // First drain processes the event.
    await ra.drainRecoveryAbandoned(client)
    expect(await openRowCount(client)).toBe(1)

    // A second drain sees the cursor already advanced — no new rows.
    await ra.drainRecoveryAbandoned(client)
    expect(await openRowCount(client)).toBe(1)
  })
})
