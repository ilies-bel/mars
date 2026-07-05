/**
 * The `workflow` task axis: enqueue → read roundtrip.
 *
 * Regression: the live-loop dogfood task (mars-d2ff2e39) persisted
 * workflow='live' but dispatched onto the task pipeline, because TASK_SEL —
 * the curated column list behind getTask/listTasks — did not select
 * `t.workflow`, so every read materialised the field as null and dispatch
 * fell back to the kind default. This test pins the roundtrip through the
 * REAL read path (enqueueTask → getTask), not a hand-built row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  enqueueTask: typeof import('../queue').enqueueTask
  getTask: typeof import('../queue').getTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-workflow-axis-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<QueueModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = await import('../queue')
  return { enqueueTask: q.enqueueTask, getTask: q.getTask }
}

describe('workflow axis roundtrip', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('persists workflow at enqueue and materialises it on read', async () => {
    const q = await loadQueue(repo)
    const created = await q.enqueueTask('do it live', undefined, {
      skipTriage: true,
      workflow: 'live',
    })
    const read = await q.getTask(created.id)
    expect(read?.workflow).toBe('live')
    // kind stays orthogonal — a live task is semantically an ordinary task.
    expect(read?.kind).toBe('task')
  })

  it('defaults to null (dispatch resolves null to the kind default)', async () => {
    const q = await loadQueue(repo)
    const created = await q.enqueueTask('background as usual', undefined, {
      skipTriage: true,
    })
    const read = await q.getTask(created.id)
    expect(read?.workflow).toBeNull()
  })
})
