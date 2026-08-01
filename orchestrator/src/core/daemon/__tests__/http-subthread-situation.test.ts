import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-subthread-situation-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const situation = 'Situation: 2 queued tasks, 1 running task, 1 blocked task, and 1 failed task. Workers: 1 of 4 active. 3 items need attention.'

describe('Subthread Situation report', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('stores a zero-token situation as the first message of human and alert Subthreads', async () => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const chatStore = await import('../../lib/chat-store')
    await chatStore.initChatStore()
    const human = await chatStore.createThread('Review deploy', { situationReport: situation })
    const alert = await chatStore.startThreadFromAlert('arc-1', 'Deploy failed', {
      type: 'alert', kind: 'failed', entityId: 'arc-1', priority: 'high',
      title: 'Deploy failed', whyNow: 'verification failed', actions: [], resolved: false,
    }, situation)

    for (const subthreadId of [human.id, alert.id]) {
      const subthread = await chatStore.getThread(subthreadId)
      expect(subthread?.messages[0]).toMatchObject({
        role: 'assistant', kind: 'situation', content: situation,
      })
      expect(subthread?.messages[0]?.segments).toEqual([{ type: 'text', text: situation }])
      expect(chatStore.toMessageApiView(subthread!.messages[0]).turnTokens).toBe(0)
    }
    expect((await chatStore.getThread(alert.id))?.messages).toHaveLength(2)

    const repeated = await chatStore.startThreadFromAlert('arc-1', 'ignored', {
      type: 'alert', kind: 'failed', entityId: 'arc-1', priority: 'high',
      title: 'ignored', whyNow: 'ignored', actions: [], resolved: false,
    }, situation)
    expect(repeated.id).toBe(alert.id)
    expect((await chatStore.getThread(alert.id))?.messages).toHaveLength(2)
  })
})
