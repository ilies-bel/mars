import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  initQueue: typeof import('../../queue').initQueue
  isTaskTag: typeof import('../../queue').isTaskTag
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-test-tag-'))
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

describe('task tag', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('defaults to "coder" when tag is not provided', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('default tagless', undefined, { skipTriage: true })
    expect(t.tag).toBe('coder')
    const fetched = await q.getTask(t.id)
    expect(fetched?.tag).toBe('coder')
  })

  it('rejects an unknown tag at enqueue with a precise message', async () => {
    const q = await loadQueue(repo)
    await expect(
      q.enqueueTask('bad', undefined, {
        skipTriage: true,
        // @ts-expect-error -- intentionally bypassing the type guard
        tag: 'reviewer',
      }),
    ).rejects.toThrow(/tag/)
  })

  it('rejects the retired "writer" tag at enqueue (structured-write lane removed, ADR 0019)', async () => {
    const q = await loadQueue(repo)
    await expect(
      q.enqueueTask('glossary slice', undefined, {
        skipTriage: true,
        // @ts-expect-error -- intentionally bypassing the type guard
        tag: 'writer',
      }),
    ).rejects.toThrow(/tag/)
  })

  it('isTaskTag narrows valid tag literals — "coder" only after ADR 0019', async () => {
    const q = await loadQueue(repo)
    expect(q.isTaskTag('coder')).toBe(true)
    // 'writer' is no longer a valid tag — the structured-write lane was removed.
    expect(q.isTaskTag('writer')).toBe(false)
    expect(q.isTaskTag('reviewer')).toBe(false)
    expect(q.isTaskTag(null)).toBe(false)
  })
})
