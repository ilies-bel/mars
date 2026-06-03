import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  isTaskTag: typeof import('../../queue').isTaskTag
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-test-tag-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<Queue> => {
  // Isolate module instances so each test starts with a fresh DB connection.
  const { vi } = await import('vitest')
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../queue')
  await mod.migrateQueueSchema()
  return mod as unknown as Queue
}

describe('task tags (list)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('stores an empty --tag invocation as the default tag list [coder]', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('default tagless', undefined, { skipTriage: true })
    expect(t.tags).toEqual(['coder'])
    const fetched = await q.getTask(t.id)
    expect(fetched?.tags).toEqual(['coder'])
  })

  it('stores a single tag provided via tags option', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('single tag task', undefined, {
      skipTriage: true,
      tags: ['reviewer'],
    })
    expect(t.tags).toEqual(['reviewer'])
    const fetched = await q.getTask(t.id)
    expect(fetched?.tags).toEqual(['reviewer'])
  })

  it('stores multiple tags — mars task add --tag a --tag b', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('multi-tag task', undefined, {
      skipTriage: true,
      tags: ['a', 'b'],
    })
    expect(t.tags).toEqual(['a', 'b'])
    const fetched = await q.getTask(t.id)
    expect(fetched?.tags).toEqual(['a', 'b'])
  })

  it('accepts formerly-retired "writer" tag', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('glossary slice', undefined, {
      skipTriage: true,
      tags: ['writer'],
    })
    expect(t.tags).toEqual(['writer'])
    const fetched = await q.getTask(t.id)
    expect(fetched?.tags).toEqual(['writer'])
  })

  it('rejects tags option containing an empty string', async () => {
    const q = await loadQueue(repo)
    await expect(
      q.enqueueTask('bad tags', undefined, {
        skipTriage: true,
        tags: ['coder', ''],
      }),
    ).rejects.toThrow(/tags must be an array of non-empty strings/)
  })

  it('rejects tags option that is not an array', async () => {
    const q = await loadQueue(repo)
    await expect(
      q.enqueueTask('bad tags', undefined, {
        skipTriage: true,
        // @ts-expect-error testing runtime guard
        tags: 'coder',
      }),
    ).rejects.toThrow(/tags must be an array of non-empty strings/)
  })

  it('isTaskTag accepts any non-empty string and rejects non-strings', async () => {
    const q = await loadQueue(repo)
    expect(q.isTaskTag('coder')).toBe(true)
    expect(q.isTaskTag('writer')).toBe(true)
    expect(q.isTaskTag('reviewer')).toBe(true)
    expect(q.isTaskTag('custom-tag')).toBe(true)
    expect(q.isTaskTag(null)).toBe(false)
    expect(q.isTaskTag(undefined)).toBe(false)
    expect(q.isTaskTag('')).toBe(false)
    expect(q.isTaskTag(42)).toBe(false)
  })
})
