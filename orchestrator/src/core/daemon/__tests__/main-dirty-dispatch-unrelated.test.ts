/**
 * Slice 2: dispatch-time handling of `classifyIntegrationDirtState` → 'unrelated'.
 *
 * Acceptance criteria:
 *  - When main has unrelated dirt (ignored entries, conflicts, submodule changes),
 *    `runMainDirtyDispatchCheck` raises exactly one action-queue alert via
 *    `raiseActionQueueItem` with signature `main-dirty:unrelated:<branch>`.
 *  - No fix task is inserted and no task_blockers edge is created.
 *  - Repeat dispatch of another task deduplicates on the signature (seen_count
 *    increments, row count stays at 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

/**
 * Build a git repo that has an ignored directory entry — enough to make
 * `classifyIntegrationDirtState` return `{ kind: 'unrelated' }`.
 *
 * Strategy: commit a `.gitignore` that ignores `ignored-dir/`, then create
 * a file inside that directory. `git status --ignored --porcelain` then shows
 * `!! ignored-dir/`, which `isCommitterUnresolvable` classifies as unrelated.
 */
const setupRepoWithIgnoredDirt = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-unrelated-dirt-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  // Commit .gitignore so git recognises the ignored directory.
  writeFileSync(resolve(repo, '.gitignore'), 'ignored-dir/\n')
  writeFileSync(resolve(repo, 'README.md'), 'hi\n')
  execFileSync('git', ['add', '.gitignore', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init', '--allow-empty'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  // Create an ignored file — this triggers `unrelated` classification.
  mkdirSync(resolve(repo, 'ignored-dir'), { recursive: true })
  writeFileSync(resolve(repo, 'ignored-dir/noise.txt'), 'noise\n')
  return repo
}

describe('runMainDirtyDispatchCheck — unrelated dirt path', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepoWithIgnoredDirt()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(async () => {
    // Close all PGlite handles opened during this test BEFORE deleting the repo
    // directory. The PGlite WASM runtime is global; leaving an orphaned instance
    // with I/O open on deleted files can corrupt subsequent tests in the same
    // process — specifically, the "could not open file base/5/..." class of
    // errors seen when the second test tries to open a fresh PGlite instance.
    const { __resetDbRegistryForTests } = await import('../../lib/db')
    await __resetDbRegistryForTests()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it(
    'raises one action-queue item and does NOT insert a fix task when main has unrelated dirt',
    async () => {
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()

      const { MAIN_COMMITER_RECIPE } = await import('../../lib/main-dirty')
      const { nullTraceStore } = await import('../../lib/run-tool')

      const sourceTask = await queue.enqueueTask('source task', undefined, { skipTriage: true })

      const mockCatalog = {
        get: (name: string) =>
          name === MAIN_COMMITER_RECIPE
            ? {
                name: MAIN_COMMITER_RECIPE,
                description: 'test',
                prompt: 'fake prompt',
                tools: [] as const,
                source: 'built-in' as const,
              }
            : null,
        list: () => [],
      }

      const logs: string[] = []
      const { runMainDirtyDispatchCheck } = await import('../main-dirty-dispatch')

      const fixTasksBefore = (
        await queue.resolveQueueClient().execute(
          `SELECT COUNT(*) AS n FROM tasks WHERE kind = 'fix'`,
        )
      ).rows[0] as unknown as { n: number }

      const result = await runMainDirtyDispatchCheck({
        task: sourceTask,
        integrationBranch: 'main',
        traceStore: nullTraceStore,
        recipeCatalog: mockCatalog as import('../../lib/recipes').RecipeCatalog,
        log: (msg) => logs.push(msg),
      })

      // Must be parked as unrelated-dirt (not a committer spawn).
      expect(result.parked).toBe(true)
      if (result.parked) {
        expect((result as { reason?: string }).reason).toBe('unrelated-dirt')
        expect(typeof (result as { actionQueueItemId?: string }).actionQueueItemId).toBe('string')
      }

      // No fix task must have been inserted.
      const fixTasksAfter = (
        await queue.resolveQueueClient().execute(
          `SELECT COUNT(*) AS n FROM tasks WHERE kind = 'fix'`,
        )
      ).rows[0] as unknown as { n: number }
      expect(Number(fixTasksAfter.n)).toBe(Number(fixTasksBefore.n))

      // No task_blockers edge for the source task.
      const blockerEdges = await queue.resolveQueueClient().execute({
        sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
        args: [sourceTask.id],
      })
      expect(Number((blockerEdges.rows[0] as unknown as { n: number }).n)).toBe(0)

      // Exactly one open action-queue row with the correct signature.
      const aqRows = await queue.resolveQueueClient().execute({
        sql: `SELECT id, body, signature, seen_count FROM action_queue_items WHERE signature = ? AND state = 'open'`,
        args: ['main-dirty:unrelated:main'],
      })
      expect(aqRows.rows.length).toBe(1)

      // Body enumerates the contaminated path.
      const row = aqRows.rows[0] as unknown as {
        id: string
        body: string
        signature: string
        seen_count: number
      }
      expect(row.body).toContain('ignored-dir/')

      // Log must reference the unrelated-dirt action.
      expect(logs.some((l) => l.includes('unrelated') || l.includes('actionQueue'))).toBe(true)
    },
    30_000,
  )

  it(
    'deduplicates on repeat dispatch — second task raises no new action-queue row',
    async () => {
      const queue = await import('../../queue')
      await queue.migrateQueueSchema()

      const { MAIN_COMMITER_RECIPE } = await import('../../lib/main-dirty')
      const { nullTraceStore } = await import('../../lib/run-tool')

      const mockCatalog = {
        get: (name: string) =>
          name === MAIN_COMMITER_RECIPE
            ? {
                name: MAIN_COMMITER_RECIPE,
                description: 'test',
                prompt: 'fake prompt',
                tools: [] as const,
                source: 'built-in' as const,
              }
            : null,
        list: () => [],
      }

      const { runMainDirtyDispatchCheck } = await import('../main-dirty-dispatch')

      const taskA = await queue.enqueueTask('task A', undefined, { skipTriage: true })
      const taskB = await queue.enqueueTask('task B', undefined, { skipTriage: true })

      await runMainDirtyDispatchCheck({
        task: taskA,
        integrationBranch: 'main',
        traceStore: nullTraceStore,
        recipeCatalog: mockCatalog as import('../../lib/recipes').RecipeCatalog,
        log: () => {},
      })

      await runMainDirtyDispatchCheck({
        task: taskB,
        integrationBranch: 'main',
        traceStore: nullTraceStore,
        recipeCatalog: mockCatalog as import('../../lib/recipes').RecipeCatalog,
        log: () => {},
      })

      // Exactly one open action-queue row — dedup fired on the second dispatch.
      const aqRows = await queue.resolveQueueClient().execute({
        sql: `SELECT id, seen_count FROM action_queue_items WHERE signature = ? AND state = 'open'`,
        args: ['main-dirty:unrelated:main'],
      })
      expect(aqRows.rows.length).toBe(1)

      const row = aqRows.rows[0] as unknown as { id: string; seen_count: number }
      expect(Number(row.seen_count)).toBe(2)

      // Still no fix tasks inserted by either dispatch.
      const fixTaskCount = (
        await queue.resolveQueueClient().execute(
          `SELECT COUNT(*) AS n FROM tasks WHERE kind = 'fix'`,
        )
      ).rows[0] as unknown as { n: number }
      expect(Number(fixTaskCount.n)).toBe(0)
    },
    30_000,
  )
})
