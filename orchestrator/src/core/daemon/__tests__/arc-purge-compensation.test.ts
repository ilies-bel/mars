/**
 * Tests for the force-purge compensation path in `coreArcPurge`.
 *
 * Acceptance criteria:
 *   (a) Force-purging an arc that had integrated work (any member with
 *       status='done') creates exactly one compensation/cleanup task. The task
 *       carries `compensatesArcId = originId` so operators can trace it back.
 *   (b) Force-purging an arc whose members only ever reached 'failed' (branch-
 *       only work that never merged) does NOT create a compensation task.
 *       The commit-ahead guard for non-force purges is preserved by the
 *       existing arc-purge.test.ts suite and is not re-tested here.
 *   (c) Repeated force operations on the same arc are idempotent: if a
 *       compensation task already exists (same followup_dedup_key), a second
 *       invocation returns the existing task id without creating a duplicate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  updateTask: typeof import('../../queue').updateTask
  listTasks: typeof import('../../queue').listTasks
}

interface ArcPurgeModule {
  coreArcPurge: typeof import('../arc-purge').coreArcPurge
}

/** Create a minimal git repo with one commit on main so git operations work. */
const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-arc-comp-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ap: ArcPurgeModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ap = (await import('../arc-purge')) as unknown as ArcPurgeModule
  return { q, ap }
}

describe('coreArcPurge — force-purge compensation', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  // ── (a) Tracer bullet: integrated work → exactly one compensation task ──────
  it('creates exactly one compensation task when the arc had integrated work (done member)', async () => {
    const { q, ap } = await loadModules(repo)

    // Origin task: status 'done' means work was merged into the integration branch.
    // No branch is set, so the done-implies-merged guard in updateTask is bypassed.
    const origin = await q.enqueueTask('implement the new widget', undefined, {
      skipTriage: true,
    })
    await q.updateTask(origin.id, { status: 'done' })

    const result = await ap.coreArcPurge(origin.id, true, 'main', repo)

    // Origin was purged.
    expect(result.originId).toBe(origin.id)
    expect(result.purgedIds).toContain(origin.id)

    // Exactly one compensation task was created.
    expect(result.compensationTaskId).toBeDefined()
    const compensation = await q.getTask(result.compensationTaskId!)
    expect(compensation).not.toBeNull()

    // The compensation task is linked to the abandoned arc.
    expect(compensation!.compensatesArcId).toBe(origin.id)

    // The compensation task is a normal task (not a fix/recovery task).
    expect(compensation!.fixForTaskId).toBeNull()
    expect(compensation!.kind).toBe('task')

    // The compensation task's prompt references the abandoned arc.
    expect(compensation!.prompt).toContain(origin.id)
    expect(compensation!.intent).toContain(origin.id)
  })

  // ── (b) Branch-only work (no done members) → no compensation task ──────────
  it('does not create a compensation task when no member had integrated work', async () => {
    const { q, ap } = await loadModules(repo)

    // Arc with only 'failed' members — never reached 'done', never merged.
    const origin = await q.enqueueTask('fix the broken pipeline', undefined, {
      skipTriage: true,
    })
    await q.updateTask(origin.id, { status: 'failed', error: 'build failed' })

    const sibling = await q.enqueueTask('retry fix', undefined, {
      skipTriage: true,
      originId: origin.id,
    })
    await q.updateTask(sibling.id, { status: 'failed', error: 'still broken' })

    const result = await ap.coreArcPurge(origin.id, true, 'main', repo)

    expect(result.purgedIds).toContain(origin.id)
    expect(result.purgedIds).toContain(sibling.id)

    // No compensation task was created.
    expect(result.compensationTaskId).toBeUndefined()

    // Confirm there are no tasks remaining (nothing was created).
    const allTasks = await q.listTasks()
    expect(allTasks).toHaveLength(0)
  })

  // ── Mixed arc: some done, some failed → compensation created ────────────────
  it('creates a compensation task when at least one member was done even if others failed', async () => {
    const { q, ap } = await loadModules(repo)

    const origin = await q.enqueueTask('implement feature X', undefined, {
      skipTriage: true,
    })
    await q.updateTask(origin.id, { status: 'done' })

    const sibling = await q.enqueueTask('follow-up fix', undefined, {
      skipTriage: true,
      originId: origin.id,
    })
    await q.updateTask(sibling.id, { status: 'failed', error: 'partial failure' })

    const result = await ap.coreArcPurge(origin.id, true, 'main', repo)

    expect(result.compensationTaskId).toBeDefined()
    const comp = await q.getTask(result.compensationTaskId!)
    expect(comp?.compensatesArcId).toBe(origin.id)
  })

  // ── (c) Idempotency: repeated force operations yield no duplicate task ──────
  it('returns the existing compensation task id on repeated force-purge without creating a duplicate', async () => {
    const { q, ap } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Create a fresh arc with integrated work.
    const origin = await q.enqueueTask('refactor auth layer', undefined, {
      skipTriage: true,
    })
    await q.updateTask(origin.id, { status: 'done' })

    // First force-purge: creates the compensation task.
    const firstResult = await ap.coreArcPurge(origin.id, true, 'main', repo)
    expect(firstResult.compensationTaskId).toBeDefined()
    const firstCompId = firstResult.compensationTaskId!

    // Verify the compensation task exists with the expected dedup key.
    const dedupKey = `arc-force-purge-compensation:${origin.id}`
    const rows = await client.execute({
      sql: `SELECT id FROM tasks WHERE followup_dedup_key = ?`,
      args: [dedupKey],
    })
    expect((rows.rows as unknown as { id: string }[]).length).toBe(1)
    expect((rows.rows as unknown as { id: string }[])[0].id).toBe(firstCompId)

    // Simulate idempotency: create another arc and pre-insert its compensation
    // task before calling coreArcPurge, then verify coreArcPurge returns the
    // pre-existing id rather than creating a duplicate.
    const origin2 = await q.enqueueTask('second arc', undefined, { skipTriage: true })
    await q.updateTask(origin2.id, { status: 'done' })
    const dedupKey2 = `arc-force-purge-compensation:${origin2.id}`

    // Pre-insert the compensation task to simulate it was already created.
    const now = new Date().toISOString()
    const preCreatedId = `mars-preexist`
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, followup_dedup_key, compensates_arc_id, priority, intent, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?)`,
      args: [
        preCreatedId,
        `Compensate for force-purged arc ${origin2.id}.`,
        preCreatedId,
        dedupKey2,
        origin2.id,
        `Compensate for force-purged arc ${origin2.id}`,
        now,
        now,
      ],
    })

    // Force-purge the second arc — should find the pre-existing compensation task.
    const secondResult = await ap.coreArcPurge(origin2.id, true, 'main', repo)
    expect(secondResult.compensationTaskId).toBe(preCreatedId)

    // No duplicate was created: still exactly one row with this dedup key.
    const rows2 = await client.execute({
      sql: `SELECT id FROM tasks WHERE followup_dedup_key = ?`,
      args: [dedupKey2],
    })
    expect((rows2.rows as unknown as { id: string }[]).length).toBe(1)
  })
})
