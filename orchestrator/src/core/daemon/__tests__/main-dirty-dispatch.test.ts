/**
 * Regression test for the phantom-blocker bug: when the integration branch
 * is dirty at a hash that matches an existing committer in status='done',
 * runMainDirtyDispatchCheck must return false — not park the source task
 * behind a dead committer that can never unblock it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    'returns false (not parked) when the only committer at this hash is already done — phantom-blocker regression',
    async () => {
      // Dirty the repo to trigger the dirty-main detection.
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
      expect(detection.hash).toBeTruthy()

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

      // Mark the committer done (simulates it successfully completing).
      await queue.updateTask(committerRes.fixTaskId, { status: 'done' })

      // --- test phase ---
      // A second task represents a re-dispatched (or newly enqueued) task
      // that hits the same dirty hash after the committer is already done.
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

      const parked = await runMainDirtyDispatchCheck({
        task: testTask,
        integrationBranch: 'main',
        traceStore: nullTraceStore,
        recipeCatalog: mockCatalog as import('../../lib/recipes').RecipeCatalog,
        log: (msg) => logs.push(msg),
      })

      // Must NOT be parked — done committer is not a live blocker.
      expect(parked).toBe(false)

      // Source task must not be blocked.
      const testTaskAfter = await queue.getTask(testTask.id)
      expect(testTaskAfter?.status).not.toBe('blocked')

      // No blocker edge between testTask and the done committer.
      const c = queue.resolveQueueClient()
      const edges = await c.execute({
        sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
        args: [testTask.id, committerRes.fixTaskId],
      })
      expect(Number((edges.rows[0] as unknown as { n: number }).n)).toBe(0)

      // Log must say "not attached", not "parked blocked".
      expect(logs.some((l) => l.includes('not attached'))).toBe(true)
      expect(logs.every((l) => !l.includes('parked blocked'))).toBe(true)
    },
    30_000,
  )
})
