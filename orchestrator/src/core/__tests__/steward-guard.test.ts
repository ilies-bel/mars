import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-steward-guard-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('Steward repeat guard', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
    process.env.MARS_FIX_RETRY_BUDGET = '10'
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('escalates a second unchanged failure after one Steward fix instead of spawning another fix', async () => {
    const queue = await import('../queue')
    await queue.migrateQueueSchema()
    const fixTasks = await import('../queue-fix-tasks')
    const actionQueue = await import('../lib/action-queue')
    const task = await queue.enqueueTask('repair the release notes', undefined, {
      skipTriage: true,
    })

    const first = await fixTasks.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: Cannot find name releaseNotes.',
    })
    expect(first.outcome).toBe('blocked')
    expect(first.fixTaskId).toBeTruthy()

    await queue.updateTask(first.fixTaskId!, { status: 'done' })

    const second = await fixTasks.handleTaskFailureWithFixTask({
      taskId: task.id,
      failingStep: 'verify:typecheck',
      errorOutput: 'TS2304: Cannot find name releaseNotes.',
    })

    expect(second.outcome).toBe('steward-repeat')
    const fixes = await queue.resolveQueueClient().execute({
      sql: 'SELECT id FROM tasks WHERE fix_for_task_id = ?',
      args: [task.id],
    })
    expect(fixes.rows).toHaveLength(1)

    const repeats = await actionQueue.listActionQueueItems('open', {
      kind: 'steward-repeat',
    })
    expect(repeats).toHaveLength(1)
    expect(repeats[0]?.payload).toMatchObject({
      targetKind: 'task',
      targetId: task.id,
      targetVersion: first.failureSignature,
    })
  })
})
