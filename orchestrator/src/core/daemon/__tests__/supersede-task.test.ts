import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  enqueueTask: typeof import('../../queue').enqueueTask
  addBlockers: typeof import('../../queue').addBlockers
  getTask: typeof import('../../queue').getTask
  updateTask: typeof import('../../queue').updateTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface SupersedeModule {
  coreSupersedeTask: typeof import('../purge-task').coreSupersedeTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-supersede-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  writeFileSync(resolve(repo, 'README.md'), 'init\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo })
  return repo
}

const loadModules = async (repo: string): Promise<{ q: QueueModule; supersede: SupersedeModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const supersede = (await import('../purge-task')) as unknown as SupersedeModule
  return { q, supersede }
}

const branchWithUniqueCommit = (repo: string, branch: string): void => {
  execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: repo })
  writeFileSync(resolve(repo, 'work.txt'), 'work already landed elsewhere\n')
  execFileSync('git', ['add', 'work.txt'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'stale work'], { cwd: repo })
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
}

describe('coreSupersedeTask', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('archives a failed task as superseded and releases its sole blocked dependent without force', async () => {
    const { q, supersede } = await loadModules(repo)
    const stale = await q.enqueueTask('stale implementation', undefined, { skipTriage: true })
    const dependent = await q.enqueueTask('dependent implementation', undefined, { skipTriage: true })
    await q.updateTask(stale.id, { status: 'failed', error: 'overtaken' })
    await q.addBlockers(dependent.id, [stale.id])
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = 'blocked' WHERE id = ?`,
      args: [dependent.id],
    })

    branchWithUniqueCommit(repo, `task/${stale.id}`)
    const mainCommit = execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim()

    await supersede.coreSupersedeTask(stale.id, mainCommit, 'recovery already landed', 'main', repo)

    expect(await q.getTask(stale.id)).toBeNull()
    expect((await q.getTask(dependent.id))?.status).toBe('queued')

    const archive = await q.resolveQueueClient().execute({
      sql: `SELECT terminal_status, superseded_by, supersede_note
              FROM purged_tasks_archive WHERE id = ?`,
      args: [stale.id],
    })
    expect(archive.rows).toEqual([
      expect.objectContaining({
        terminal_status: 'superseded',
        superseded_by: mainCommit,
        supersede_note: 'recovery already landed',
      }),
    ])
  })

  it('rejects unverifiable evidence without changing the task', async () => {
    const { q, supersede } = await loadModules(repo)
    const stale = await q.enqueueTask('stale implementation', undefined, { skipTriage: true })
    await q.updateTask(stale.id, { status: 'failed', error: 'overtaken' })

    await expect(
      supersede.coreSupersedeTask(stale.id, 'deadbeef', undefined, 'main', repo),
    ).rejects.toThrow('not reachable from integration branch main')
    expect((await q.getTask(stale.id))?.status).toBe('failed')
  })

  it('rejects an in-flight task and a task reference that has not reached done', async () => {
    const { q, supersede } = await loadModules(repo)
    const inFlight = await q.enqueueTask('still running', undefined, { skipTriage: true })
    const notDone = await q.enqueueTask('unfinished evidence', undefined, { skipTriage: true })
    await q.updateTask(inFlight.id, { status: 'running' })

    await expect(
      supersede.coreSupersedeTask(inFlight.id, notDone.id, undefined, 'main', repo),
    ).rejects.toThrow("only accepts failed/blocked/dropped tasks")
    expect((await q.getTask(inFlight.id))?.status).toBe('running')

    const stale = await q.enqueueTask('failed task', undefined, { skipTriage: true })
    await q.updateTask(stale.id, { status: 'failed', error: 'overtaken' })
    await expect(
      supersede.coreSupersedeTask(stale.id, notDone.id, undefined, 'main', repo),
    ).rejects.toThrow(`task ${notDone.id} is queued; --by task evidence must be done`)
    expect((await q.getTask(stale.id))?.status).toBe('failed')
  })
})
