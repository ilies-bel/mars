/**
 * Tests for the optimised listFailedArcs implementation (failed-arc-sources.ts).
 *
 * Covers:
 *   - Correctness: failed arcs are returned, in-progress and done arcs are excluded.
 *   - Chain / descendants structure.
 *   - Timing regression: 20 failed arcs must be processed under 1 000 ms on
 *     PGlite (the in-process DB used in CI and in tests).  This guard prevents
 *     re-introducing per-arc O(N) DB or subprocess work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ── Type-only shim so the test file compiles without loading the real modules ──
interface QueueModule {
  enqueueTask: typeof import('../queue').enqueueTask
  updateTask: typeof import('../queue').updateTask
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  ensureQueueSchema: typeof import('../queue').ensureQueueSchema
}

interface SourcesModule {
  listFailedArcs: typeof import('./failed-arc-sources').listFailedArcs
}

// ── Hermetic DB setup ──────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-failed-arc-test-'))
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; src: SourcesModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const src = (await import('./failed-arc-sources')) as unknown as SourcesModule
  return { q, src }
}

describe('listFailedArcs — correctness', () => {
  let repo: string
  let q: QueueModule
  let src: SourcesModule

  beforeEach(async () => {
    repo = setupRepo()
    ;({ q, src } = await loadModules(repo))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns an empty array when there are no tasks', async () => {
    const records = await src.listFailedArcs()
    expect(records).toHaveLength(0)
  })

  it('includes a fully-failed arc', async () => {
    const t = await q.enqueueTask('build the widget', undefined, {
      intent: 'build the widget fast',
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', failure_signature = 'verify:typecheck/error' WHERE id = ?`,
      args: [t.id],
    })

    const records = await src.listFailedArcs()
    expect(records).toHaveLength(1)
    expect(records[0]?.arcId).toBe(t.id)
    expect(records[0]?.goal).toBe('build the widget fast')
    expect(records[0]?.failureSignature).toBe('verify:typecheck/error')
    expect(records[0]?.chain).toHaveLength(1)
    expect(records[0]?.chain[0]?.kind).toBe('task')
    expect(records[0]?.chain[0]?.attemptIndex).toBe(1)
  })

  it('excludes an in-progress arc (non-terminal task)', async () => {
    const t = await q.enqueueTask('pending work')
    // Leave status as 'queued' — arc is in progress.
    void t
    const records = await src.listFailedArcs()
    expect(records).toHaveLength(0)
  })

  it('excludes an arc-done arc (at least one done task)', async () => {
    const t = await q.enqueueTask('successful work')
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [t.id],
    })

    const records = await src.listFailedArcs()
    expect(records).toHaveLength(0)
  })

  it('sets blockedCount = 0 when there are no blocked dependents', async () => {
    const t = await q.enqueueTask('failing task')
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [t.id],
    })

    const records = await src.listFailedArcs()
    expect(records[0]?.blockedCount).toBe(0)
  })

  it('includes descendants in the record', async () => {
    // Create an origin task + a recovery fix task sharing the same origin_id.
    const origin = await q.enqueueTask('origin task')
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed' WHERE id = ?`,
      args: [origin.id],
    })
    // Insert a fix task that references the origin via origin_id.
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, fix_for_task_id, origin_id,
                               priority, author_kind, author_name,
                               recovery_spawned_count, created_at, updated_at)
            VALUES ('fix-001', 'fix the origin', 'failed', 'fix', ?, ?,
                    0, 'agent', 'recovery', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      args: [origin.id, origin.id],
    })

    const records = await src.listFailedArcs()
    expect(records).toHaveLength(1)
    expect(records[0]?.arcId).toBe(origin.id)
    expect(records[0]?.descendants).toHaveLength(1)
    expect(records[0]?.descendants[0]?.id).toBe('fix-001')
    // Fix task shows up in the recovery section of the chain.
    const recoveryNode = records[0]?.chain.find(
      (n) => n.kind === 'task' && n.id === 'fix-001',
    )
    expect(recoveryNode).toBeDefined()
    expect(recoveryNode?.attemptIndex).toBeUndefined()
  })
})

describe('listFailedArcs — timing regression (20 failed arcs < 1 000 ms)', () => {
  let repo: string
  let q: QueueModule
  let src: SourcesModule

  beforeEach(async () => {
    repo = setupRepo()
    ;({ q, src } = await loadModules(repo))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('processes 20 failed arcs in under 1 000 ms', async () => {
    // Seed 20 independent failed-arc origin tasks.
    const ARC_COUNT = 20

    const ids: string[] = []
    for (let i = 0; i < ARC_COUNT; i++) {
      const t = await q.enqueueTask(`failing task ${i}`, undefined, {
        intent: `intent for task ${i}`,
      })
      ids.push(t.id)
    }
    // Mark all as failed in a single batch UPDATE.
    const placeholders = ids.map(() => '?').join(', ')
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'failed', failure_signature = 'verify:typecheck/error' WHERE id IN (${placeholders})`,
      args: ids,
    })

    const start = performance.now()
    const records = await src.listFailedArcs()
    const elapsed = performance.now() - start

    // All 20 arcs must be returned.
    expect(records).toHaveLength(ARC_COUNT)

    // Must complete in under 1 000 ms even on PGlite (in-process, no network).
    // The pre-fix implementation with per-arc arcStatus() + git log took 5–15 s
    // on a 20-arc fixture; the batch implementation runs in < 100 ms.
    expect(elapsed).toBeLessThan(1000)
  }, 15_000 /* generous CI timeout; failure is expected to be < 1 s */)
})
