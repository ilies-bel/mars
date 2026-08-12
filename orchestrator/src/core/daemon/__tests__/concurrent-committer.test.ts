/**
 * Concurrency regression for the branch-keyed main-committer singleton
 * (ADR-0071, migration 0008).
 *
 * WHAT THIS COVERS.
 * `spawnOrAttachMainCommitter` used to be a bare read-then-write with no lock:
 * two callers that both saw `kind='none'` would each INSERT a new committer row.
 * The DB-level partial unique index `uq_tasks_active_main_committer` now aborts
 * the second INSERT and the application layer catches the 23505 violation,
 * re-resolves, and attaches to the winner.
 *
 * Tests:
 *  1. N concurrent spawns for the SAME branch → exactly one committer row,
 *     every other caller returns `spawned: false` with a blockers edge onto
 *     the single winner.
 *  2. Concurrent spawns for TWO DISTINCT branches → two independent committers
 *     (the index must not over-constrain across branches).
 *  3. Zombie-reap-then-respawn still works: one caller reaps the zombie and
 *     spawns a replacement; a concurrent caller that also read `none` (post-reap)
 *     loses the INSERT race and attaches instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupCleanRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-concurrent-committer-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, '.gitignore'), '.mars*\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('branch-keyed main-committer singleton (ADR-0071)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupCleanRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // Test 1: N concurrent spawns on the same branch → exactly one committer
  // ---------------------------------------------------------------------------

  it('N concurrent spawns on the same branch create exactly one committer row', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    process.env.MARS_REPO = repo

    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const mainDirty = await import('../../lib/main-dirty')
    const { nullTraceStore } = await import('../../lib/run-tool')

    const N = 6
    const DIRTY = { dirty: true as const, statusOutput: ' M src/thing.ts\n' }

    // Enqueue N source tasks, one per concurrent caller.
    const sources = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        queue.enqueueTask(`concurrent-src-${i}`, undefined, { skipTriage: true }),
      ),
    )

    // Fire all N spawn-or-attach calls concurrently.
    const results = await Promise.all(
      sources.map((src) =>
        mainDirty.spawnOrAttachMainCommitter({
          sourceTaskId: src.id,
          detection: DIRTY,
          integrationBranch: 'main',
          dispatchPhase: 'dispatch',
          recipePrompt: 'commit',
          sourceOriginId: src.id,
          traceStore: nullTraceStore,
        }),
      ),
    )

    // Exactly one caller spawned; the rest attached.
    const spawned = results.filter((r) => r.spawned)
    const attached = results.filter((r) => !r.spawned)
    expect(spawned).toHaveLength(1)
    expect(attached).toHaveLength(N - 1)

    // All callers agree on the same fixTaskId.
    const fixTaskIds = new Set(results.map((r) => r.fixTaskId))
    expect(fixTaskIds.size).toBe(1)
    const [fixTaskId] = fixTaskIds

    // That committer is a real queued task.
    const committer = await queue.getTask(fixTaskId)
    expect(committer?.status).toBe('queued')
    expect(committer?.kind).toBe('fix')

    // Every source is now blocked behind the single committer.
    for (const src of sources) {
      expect((await queue.getTask(src.id))?.status).toBe('blocked')
      const edges = await queue.resolveQueueClient().execute({
        sql: `SELECT blocker_task_id AS b FROM task_blockers WHERE task_id = ?`,
        args: [src.id],
      })
      const blockers = (edges.rows as unknown as Array<{ b: string }>).map(
        (r) => r.b,
      )
      expect(blockers).toContain(fixTaskId)
    }

    // The DB has exactly one active committer for the branch.
    const activeRows = await queue.resolveQueueClient().execute({
      sql: `SELECT id FROM tasks
              WHERE kind = 'fix'
                AND status IN ('queued','running','verifying','merging','vega-reconciling','blocked')
                AND recovery_payload::jsonb ->> 'recipe' = 'main-commiter'
                AND recovery_payload::jsonb ->> 'integrationBranch' = 'main'`,
      args: [],
    })
    expect(activeRows.rows).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // Test 2: Two distinct branches each get their own committer
  // ---------------------------------------------------------------------------

  it('concurrent spawns on different branches each create an independent committer', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    process.env.MARS_REPO = repo

    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const mainDirty = await import('../../lib/main-dirty')
    const { nullTraceStore } = await import('../../lib/run-tool')

    const DIRTY = { dirty: true as const, statusOutput: ' M src/thing.ts\n' }
    const BRANCHES = ['main', 'staging']

    const sources = await Promise.all(
      BRANCHES.map((branch) =>
        queue.enqueueTask(`branch-src-${branch}`, undefined, { skipTriage: true }),
      ),
    )

    const results = await Promise.all(
      sources.map((src, i) =>
        mainDirty.spawnOrAttachMainCommitter({
          sourceTaskId: src.id,
          detection: DIRTY,
          integrationBranch: BRANCHES[i],
          dispatchPhase: 'dispatch',
          recipePrompt: 'commit',
          sourceOriginId: src.id,
          traceStore: nullTraceStore,
        }),
      ),
    )

    // Both spawned — the index is per-branch, so different branches do not
    // conflict with each other.
    expect(results[0].spawned).toBe(true)
    expect(results[1].spawned).toBe(true)

    // They must have distinct committer ids.
    expect(results[0].fixTaskId).not.toBe(results[1].fixTaskId)

    // Each branch has exactly one active committer.
    for (const branch of BRANCHES) {
      const rows = await queue.resolveQueueClient().execute({
        sql: `SELECT id FROM tasks
                WHERE kind = 'fix'
                  AND status IN ('queued','running','verifying','merging','vega-reconciling','blocked')
                  AND recovery_payload::jsonb ->> 'recipe' = 'main-commiter'
                  AND recovery_payload::jsonb ->> 'integrationBranch' = ?`,
        args: [branch],
      })
      expect(rows.rows).toHaveLength(1)
    }
  })

  // ---------------------------------------------------------------------------
  // Test 3: Zombie-reap-then-spawn still produces exactly one replacement
  // ---------------------------------------------------------------------------

  it('zombie-reap-then-concurrent-spawn still yields one replacement committer', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    process.env.MARS_REPO = repo

    const queue = await import('../../queue')
    await queue.migrateQueueSchema()
    const mainDirty = await import('../../lib/main-dirty')
    const liveness = await import('../../lib/worker-liveness')
    const { nullTraceStore } = await import('../../lib/run-tool')

    const DIRTY = { dirty: true as const, statusOutput: ' M src/thing.ts\n' }

    // Source 1 spawns the committer.
    const src1 = await queue.enqueueTask('zombie-src-1', undefined, { skipTriage: true })
    const first = await mainDirty.spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection: DIRTY,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'commit',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    expect(first.spawned).toBe(true)

    // The committer transitions to 'running' and then the daemon restarts — row
    // stays running but worker is gone. Age it past the grace window.
    await queue.updateTask(first.fixTaskId, { status: 'running' })
    await queue.resolveQueueClient().execute({
      sql: `UPDATE tasks SET updated_at = NOW() - INTERVAL '10 minutes' WHERE id = ?`,
      args: [first.fixTaskId],
    })
    liveness.setWorkerLivenessProbe(() => false)

    // Two sources concurrently detect dirty-main and race to replace the zombie.
    const src2 = await queue.enqueueTask('zombie-src-2', undefined, { skipTriage: true })
    const src3 = await queue.enqueueTask('zombie-src-3', undefined, { skipTriage: true })

    const [res2, res3] = await Promise.all([
      mainDirty.spawnOrAttachMainCommitter({
        sourceTaskId: src2.id,
        detection: DIRTY,
        integrationBranch: 'main',
        dispatchPhase: 'dispatch',
        recipePrompt: 'commit',
        sourceOriginId: src2.id,
        traceStore: nullTraceStore,
      }),
      mainDirty.spawnOrAttachMainCommitter({
        sourceTaskId: src3.id,
        detection: DIRTY,
        integrationBranch: 'main',
        dispatchPhase: 'dispatch',
        recipePrompt: 'commit',
        sourceOriginId: src3.id,
        traceStore: nullTraceStore,
      }),
    ])

    // The zombie was reaped.
    expect((await queue.getTask(first.fixTaskId))?.status).toBe('failed')

    // Exactly one new committer was created; the other caller attached.
    const spawned = [res2, res3].filter((r) => r.spawned)
    const attached = [res2, res3].filter((r) => !r.spawned)
    expect(spawned).toHaveLength(1)
    expect(attached).toHaveLength(1)

    // Both agree on the same replacement fixTaskId.
    expect(res2.fixTaskId).toBe(res3.fixTaskId)
    expect(res2.fixTaskId).not.toBe(first.fixTaskId)

    // Exactly one active committer on the branch.
    const activeRows = await queue.resolveQueueClient().execute({
      sql: `SELECT id FROM tasks
              WHERE kind = 'fix'
                AND status IN ('queued','running','verifying','merging','vega-reconciling','blocked')
                AND recovery_payload::jsonb ->> 'recipe' = 'main-commiter'
                AND recovery_payload::jsonb ->> 'integrationBranch' = 'main'`,
      args: [],
    })
    expect(activeRows.rows).toHaveLength(1)

    // Clean up liveness probe.
    liveness.setWorkerLivenessProbe(null)
  })
})
