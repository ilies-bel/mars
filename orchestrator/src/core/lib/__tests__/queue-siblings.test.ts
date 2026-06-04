import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-siblings-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../queue')
  await mod.migrateQueueSchema()
  return mod
}

describe('queue.listSiblings / queue.listTasksForProposal', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('listSiblings excludes self and returns other tasks sharing origin_id', async () => {
    const q = await loadQueue(repo)
    const ideaId = 'idea-feature-12345678'
    const a = await q.enqueueTask('slice A', undefined, {
      skipTriage: true,
      originId: ideaId,
    })
    const b = await q.enqueueTask('slice B', undefined, {
      skipTriage: true,
      originId: ideaId,
    })
    const c = await q.enqueueTask('slice C', undefined, {
      skipTriage: true,
      originId: ideaId,
    })

    const siblingsOfA = await q.listSiblings(ideaId, a.id)
    expect(siblingsOfA).toHaveLength(2)
    expect(siblingsOfA).toContain(b.id)
    expect(siblingsOfA).toContain(c.id)
    expect(siblingsOfA).not.toContain(a.id)
  })

  it('listSiblings returns [] when originId equals the excluded task id', async () => {
    const q = await loadQueue(repo)
    // A direct mars-task-add row whose origin_id defaults to its own id.
    const t = await q.enqueueTask('solo', undefined, { skipTriage: true })
    const siblings = await q.listSiblings(t.originId, t.id)
    expect(siblings).toEqual([])
  })

  it('listSiblings returns [] when no other rows share origin_id', async () => {
    const q = await loadQueue(repo)
    const ideaId = 'idea-singleton-87654321'
    const only = await q.enqueueTask('only slice', undefined, {
      skipTriage: true,
      originId: ideaId,
    })
    const siblings = await q.listSiblings(ideaId, only.id)
    expect(siblings).toEqual([])
  })

  it('listTasksForProposal returns every task whose origin_id matches the proposal', async () => {
    const q = await loadQueue(repo)
    const ideaId = 'idea-prd-deadbeef'
    const a = await q.enqueueTask('slice 1', undefined, {
      skipTriage: true,
      originId: ideaId,
    })
    const b = await q.enqueueTask('slice 2', undefined, {
      skipTriage: true,
      originId: ideaId,
    })
    const c = await q.enqueueTask('slice 3', undefined, {
      skipTriage: true,
      originId: ideaId,
    })
    // A noise row with a different origin_id must not appear.
    await q.enqueueTask('unrelated', undefined, {
      skipTriage: true,
      originId: 'idea-other-cafebabe',
    })

    const tasks = await q.listTasksForProposal(ideaId)
    const ids = tasks.map((t) => t.id)
    expect(ids).toHaveLength(3)
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id, c.id]))
    // Each entry carries a status string from the row.
    for (const t of tasks) {
      expect(typeof t.status).toBe('string')
      expect(t.status.length).toBeGreaterThan(0)
    }
  })

  it('listTasksForProposal returns [] for a proposal with no slices', async () => {
    const q = await loadQueue(repo)
    const tasks = await q.listTasksForProposal('idea-empty-00000000')
    expect(tasks).toEqual([])
  })
})
