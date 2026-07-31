import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-thread-tasks-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('chat thread task links', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(async () => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('lists the two tasks created from a chat thread in creation order', async () => {
    process.env.MARS_REPO = repo
    const queue = await import('../../queue.js')
    const { listTasksForThread } = await import('../chat-thread-tasks.js')
    await queue.migrateQueueSchema()

    const first = await queue.enqueueTask('First request from the operator.', undefined, {
      skipTriage: true,
      chatThreadId: 'thread-17',
    })
    const second = await queue.enqueueTask('Second request from the operator.', undefined, {
      skipTriage: true,
      chatThreadId: 'thread-17',
    })

    expect((await listTasksForThread('thread-17', queue.resolveQueueClient())).map(({ taskId }) => taskId)).toEqual([
      first.id,
      second.id,
    ])
  })
})
