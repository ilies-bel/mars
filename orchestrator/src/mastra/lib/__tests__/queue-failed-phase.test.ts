import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  updateTask: typeof import('../../queue').updateTask
  initQueue: typeof import('../../queue').initQueue
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-fp-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<Queue> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../queue')
  await mod.initQueue()
  return mod as unknown as Queue
}

describe('tasks.failed_phase / resume_from columns', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('defaults failedPhase and resumeFrom to null for new tasks', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const fetched = await q.getTask(t.id)
    expect(fetched?.failedPhase).toBeNull()
    expect(fetched?.resumeFrom).toBeNull()
  })

  it('round-trips failedPhase through updateTask', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('verify-fail task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, { status: 'failed', failedPhase: 'verify' })
    const fetched = await q.getTask(t.id)
    expect(fetched?.status).toBe('failed')
    expect(fetched?.failedPhase).toBe('verify')
  })

  it('round-trips resumeFrom and clears it independently of failedPhase', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('merge-fail task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: 'merge',
      resumeFrom: 'merge',
    })
    const stamped = await q.getTask(t.id)
    expect(stamped?.failedPhase).toBe('merge')
    expect(stamped?.resumeFrom).toBe('merge')

    await q.updateTask(t.id, { resumeFrom: null })
    const cleared = await q.getTask(t.id)
    expect(cleared?.failedPhase).toBe('merge')
    expect(cleared?.resumeFrom).toBeNull()
  })

  it("coerces unknown strings on the column back to null", async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('weird row', undefined, { skipTriage: true })
    const { createClient } = await import('@libsql/client')
    const c = createClient({ url: `file:${repo}/.mars/queue.db` })
    await c.execute({
      sql: `UPDATE tasks SET failed_phase = ?, resume_from = ? WHERE id = ?`,
      args: ['nonsense', '', t.id],
    })
    c.close()
    const fetched = await q.getTask(t.id)
    expect(fetched?.failedPhase).toBeNull()
    expect(fetched?.resumeFrom).toBeNull()
  })
})
