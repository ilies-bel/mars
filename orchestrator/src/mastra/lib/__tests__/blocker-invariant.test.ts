import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
  addBlockers: typeof import('../../queue').addBlockers
}

interface InvariantModule {
  countBlockerEdges: typeof import('../blocker-invariant').countBlockerEdges
  hasBlockerEdge: typeof import('../blocker-invariant').hasBlockerEdge
  assertHasBlockerEdge: typeof import('../blocker-invariant').assertHasBlockerEdge
  BlockerInvariantViolation: typeof import('../blocker-invariant').BlockerInvariantViolation
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-blocker-invariant-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; inv: InvariantModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const inv = (await import(
    '../blocker-invariant'
  )) as unknown as InvariantModule
  return { q, inv }
}

describe('blocker-invariant', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('countBlockerEdges returns 0 for a task with no blockers', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('lonely', undefined, { skipTriage: true })
    expect(await inv.countBlockerEdges(t.id)).toBe(0)
    expect(await inv.hasBlockerEdge(t.id)).toBe(false)
  })

  it('countBlockerEdges returns the count once edges exist', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const b1 = await q.enqueueTask('blocker1', undefined, { skipTriage: true })
    const b2 = await q.enqueueTask('blocker2', undefined, { skipTriage: true })
    await q.addBlockers(t.id, [b1.id, b2.id])
    expect(await inv.countBlockerEdges(t.id)).toBe(2)
    expect(await inv.hasBlockerEdge(t.id)).toBe(true)
  })

  it('assertHasBlockerEdge throws BlockerInvariantViolation when zero edges', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('edgeless', undefined, { skipTriage: true })
    await expect(inv.assertHasBlockerEdge(t.id)).rejects.toBeInstanceOf(
      inv.BlockerInvariantViolation,
    )
  })

  it('assertHasBlockerEdge resolves quietly when at least one edge exists', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('parent', undefined, { skipTriage: true })
    const b = await q.enqueueTask('blocker', undefined, { skipTriage: true })
    await q.addBlockers(t.id, [b.id])
    await expect(inv.assertHasBlockerEdge(t.id)).resolves.toBeUndefined()
  })

  it('BlockerInvariantViolation carries the taskId for callers to route to failed', async () => {
    const { q, inv } = await loadModules(repo)
    const t = await q.enqueueTask('edgeless', undefined, { skipTriage: true })
    try {
      await inv.assertHasBlockerEdge(t.id)
      throw new Error('expected throw')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(inv.BlockerInvariantViolation)
      if (err instanceof inv.BlockerInvariantViolation) {
        expect(err.taskId).toBe(t.id)
      }
    }
  })
})
