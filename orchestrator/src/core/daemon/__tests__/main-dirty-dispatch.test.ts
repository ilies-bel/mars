/**
 * Tests for runMainDirtyDispatchCheck behavior when a done committer exists,
 * and for the isDispatchDirtyMainExempt predicate that gates the check in
 * dispatchImplement.
 *
 * Invariant 2 (2026-07-03): done committers never satisfy the dedup — a done
 * committer means the integration branch was clean when it verified. If main
 * is dirty again (new detection), a fresh committer must be spawned and the
 * source task must be parked behind it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isDispatchDirtyMainExempt } from '../server'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-dispatch-check-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'hi\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init', '--allow-empty'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// ---------------------------------------------------------------------------
// isDispatchDirtyMainExempt — dispatch-time dirty-main check exemption guard
//
// Slice 3: report workflow tasks never merge, so a dirty integration branch
// cannot block them. The guard in dispatchImplement (server.ts) must skip
// runMainDirtyDispatchCheck and proceed straight to the workflow loader when
// the task carries workflow='report'.
// ---------------------------------------------------------------------------

describe('isDispatchDirtyMainExempt', () => {
  it('report workflow task with dirty main skips the dirty-main check (proceeds to workflow loader)', () => {
    // This is the core Slice-3 invariant: workflow='report' tasks are read-only
    // and never merge back into the integration branch, so runMainDirtyDispatchCheck
    // must NOT be invoked for them — they are exempt.
    expect(isDispatchDirtyMainExempt({ kind: 'task', workflow: 'report' })).toBe(true)
  })

  it('fix (recovery) task is also exempt — the commiter IS the dirty-main remedy', () => {
    expect(isDispatchDirtyMainExempt({ kind: 'fix', workflow: null })).toBe(true)
  })

  it('a fix task with workflow=report is still exempt', () => {
    expect(isDispatchDirtyMainExempt({ kind: 'fix', workflow: 'report' })).toBe(true)
  })

  it('regular implement task is NOT exempt — dirty-main check applies', () => {
    expect(isDispatchDirtyMainExempt({ kind: 'task', workflow: null })).toBe(false)
    expect(isDispatchDirtyMainExempt({ kind: 'task', workflow: 'implement' })).toBe(false)
  })

  it('live task is NOT exempt', () => {
    expect(isDispatchDirtyMainExempt({ kind: 'live', workflow: null })).toBe(false)
  })
})

describe('runMainDirtyDispatchCheck', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    'spawns a fresh committer and parks the source when the only committer at this hash is already done',
    async () => {
      // Invariant 2: a done committer never absorbs new dirty-main detections.
      // A done committer only proves main was clean when it verified; if main is
      // dirty again, a fresh committer must clean it. The source task must be
      // parked behind the fresh committer (not the dead done one).
      writeFileSync(resolve(repo, 'README.md'), 'dirty\n')

      const { checkIntegrationBranchDirty, spawnOrAttachMainCommitter, MAIN_COMMITER_RECIPE } =
        await import('../../lib/main-dirty')
      const { nullTraceStore } = await import('../../lib/run-tool')
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()

      // --- seed phase ---
      // Create a source task and spawn a committer at the current dirty hash.
      const seedTask = await queue.enqueueTask('seed task', undefined, { skipTriage: true })

      const detection = await checkIntegrationBranchDirty({
        repoRoot: repo,
        integrationBranch: 'main',
        traceCtx: { store: nullTraceStore, phase: 'setup' },
      })
      expect(detection.dirty).toBe(true)
      expect(detection.statusOutput).toBeTruthy()

      const committerRes = await spawnOrAttachMainCommitter({
        sourceTaskId: seedTask.id,
        detection,
        integrationBranch: 'main',
        dispatchPhase: 'dispatch',
        recipePrompt: 'fake prompt',
        sourceOriginId: seedTask.id,
        traceStore: nullTraceStore,
      })
      expect(committerRes.spawned).toBe(true)

      // Mark the committer done (simulates it completing — but main is still dirty
      // because e.g. git stash couldn't capture all files).
      await queue.updateTask(committerRes.fixTaskId, { status: 'done' })

      // --- test phase ---
      // A second task hits the same dirty hash after the committer is already done.
      const testTask = await queue.enqueueTask('test task', undefined, { skipTriage: true })

      const mockCatalog = {
        get: (name: string) =>
          name === MAIN_COMMITER_RECIPE
            ? { name: MAIN_COMMITER_RECIPE, description: 'test', prompt: 'fake prompt', tools: [] as const, source: 'built-in' as const }
            : null,
        list: () => [],
      }

      const logs: string[] = []
      const { runMainDirtyDispatchCheck } = await import('../main-dirty-dispatch')

      const result = await runMainDirtyDispatchCheck({
        task: testTask,
        integrationBranch: 'main',
        traceStore: nullTraceStore,
        recipeCatalog: mockCatalog as import('../../lib/recipes').RecipeCatalog,
        log: (msg) => logs.push(msg),
      })

      // Must be parked — done committer is NOT satisfied as dedup; a fresh
      // committer was spawned and testTask is blocked behind it.
      expect(result.parked).toBe(true)
      // Caller must know a fresh committer was spawned so it can emit task.queued.
      // Narrow to the committer-scope variant (has fixTaskId/spawned).
      if (result.parked && 'fixTaskId' in result) {
        expect(result.spawned).toBe(true)
        expect(result.fixTaskId).toBeTruthy()
      }

      // Source task must be blocked (on the fresh committer).
      const testTaskAfter = await queue.getTask(testTask.id)
      expect(testTaskAfter?.status).toBe('blocked')

      // No blocker edge between testTask and the OLD done committer.
      const c = queue.resolveQueueClient()
      const edgesToOld = await c.execute({
        sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
        args: [testTask.id, committerRes.fixTaskId],
      })
      expect(Number((edgesToOld.rows[0] as unknown as { n: number }).n)).toBe(0)

      // Log must include "parked blocked" (not "not attached").
      expect(logs.some((l) => l.includes('parked blocked'))).toBe(true)
    },
    30_000,
  )
})
