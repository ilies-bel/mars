/**
 * A minted Notice is also a deterministic Mars entry in the current chat feed.
 *
 * The test crosses the public Notice and chat-store APIs instead of inspecting
 * SQL, so the storage details may change without weakening this guarantee.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { ActionQueueKind } from '../action-queue'

interface NoticeStoreModule {
  initNoticeStore: () => Promise<void>
  createNotice: (
    kind: ActionQueueKind,
    payload: Record<string, unknown>,
    source: string,
  ) => Promise<import('../notice-store').Notice>
}

interface ChatStoreModule {
  createThread: typeof import('../chat-store').createThread
  getThread: typeof import('../chat-store').getThread
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-notice-chat-mirror-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadStores = async (repo: string): Promise<{ notices: NoticeStoreModule; chat: ChatStoreModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const notices = (await import('../notice-store')) as unknown as NoticeStoreModule
  const chat = (await import('../chat-store')) as unknown as ChatStoreModule
  await notices.initNoticeStore()
  return { notices, chat }
}

describe('notice-store chat mirror', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('adds a template-rendered Mars message to the current chat feed without calling the LLM', async () => {
    const { notices, chat } = await loadStores(repo)
    const currentThread = await chat.createThread('current session')
    const transport = await import('../../daemon/codex-api')
    const stream = vi.spyOn(transport, 'streamCodexResponse')

    await notices.createNotice(
      'spend-control-notice',
      { direction: 'paused' },
      'spend-control',
    )

    const messages = (await chat.getThread(currentThread.id))!.messages
    expect(messages).toHaveLength(1)
    expect(messages).toMatchObject([
      {
        role: 'assistant',
        content: 'The spend controller has paused dispatch — token spend crossed the configured threshold.',
      },
    ])
    expect(stream).not.toHaveBeenCalled()
  })
})
