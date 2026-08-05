import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-action-queue-view-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('AppServices action queue view', () => {
  let repo: string
  let previousRepo: string | undefined
  let previousProfileSetting: string | undefined

  beforeEach(() => {
    repo = setupRepo()
    previousRepo = process.env.MARS_REPO
    previousProfileSetting = process.env.MARS_ACTION_QUEUE_VIEW_PROFILE
    process.env.MARS_REPO = repo
    process.env.MARS_ACTION_QUEUE_VIEW_PROFILE = '1'
  })

  afterEach(() => {
    if (previousRepo === undefined) {
      delete process.env.MARS_REPO
    } else {
      process.env.MARS_REPO = previousRepo
    }
    if (previousProfileSetting === undefined) {
      delete process.env.MARS_ACTION_QUEUE_VIEW_PROFILE
    } else {
      process.env.MARS_ACTION_QUEUE_VIEW_PROFILE = previousProfileSetting
    }
    rmSync(repo, { recursive: true, force: true })
  })

  it('keeps the open action queue view bounded to active rows after thousands of completed tasks', async () => {
    const { __resetContextCacheForTests } = await import('../context.js')
    const { __resetDbRegistryForTests } = await import('../lib/db.js')
    __resetContextCacheForTests()
    await __resetDbRegistryForTests()

    const { getCompositionRootClient, runCompositionRootMigrations } =
      await import('../store/task-store.js')
    const { raiseActionQueueItem } = await import('../lib/action-queue.js')
    const { createAppServices } = await import('../app-services.js')
    const { nullTraceStore } = await import('../lib/run-tool.js')

    await runCompositionRootMigrations()
    const db = getCompositionRootClient()
    await db.execute(`INSERT INTO tasks (id, prompt, status, created_at, updated_at)
      SELECT 'completed-' || n, 'completed task', 'done', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM generate_series(1, 2500) AS series(n)`)
    await db.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, ?, 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      args: ['active-task', 'Repair the active task'],
    })
    await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: 'Active task failed',
      body: 'Only this task requires an operator.',
      payload: { taskId: 'active-task' },
      context: {},
      raisedBy: 'test',
      signature: 'active-task',
    })

    const profile = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const services = createAppServices({
      traceStore: nullTraceStore,
      buildAlertSources: async () => ({
        listFailedArcs: async () => [],
        listStaleWorktrees: async () => [],
        listVerifyUncovered: async () => [],
      }),
    })

    const rows = await services.viewActionQueue('open')

    expect(rows).toHaveLength(1)
    expect(rows[0]?.entityId).toBe('active-task')
    expect(profile).toHaveBeenCalledWith(
      expect.stringContaining('visible_rows=1 task_graph_rows=1'),
    )
    profile.mockRestore()
  }, 60_000)
})
