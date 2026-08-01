import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../core/lib/db.js'
import type { EventName, EventPayload } from '../../bus/events.js'

interface QueueModule {
  ensureQueueSchema: typeof import('../../core/queue').ensureQueueSchema
  resolveQueueClient: typeof import('../../core/queue').resolveQueueClient
}

interface ChatStoreModule {
  createThread: typeof import('../../core/lib/chat-store').createThread
  getThread: typeof import('../../core/lib/chat-store').getThread
}

interface SubjectCloserModule {
  ensureSubjectCloser: typeof import('./subject-closer').ensureSubjectCloser
  drainSubjectCloser: typeof import('./subject-closer').drainSubjectCloser
}

interface PublisherModule {
  publishWithRetry: typeof import('../../bus/publisher').publishWithRetry
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-subject-closer-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<{
  client: DbClient
  chat: ChatStoreModule
  closer: SubjectCloserModule
  publisher: PublisherModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../core/queue')) as unknown as QueueModule
  await queue.ensureQueueSchema()
  return {
    client: queue.resolveQueueClient(),
    chat: (await import('../../core/lib/chat-store')) as unknown as ChatStoreModule,
    closer: (await import('./subject-closer')) as unknown as SubjectCloserModule,
    publisher: (await import('../../bus/publisher')) as unknown as PublisherModule,
  }
}

const publish = async <T extends EventName>(
  publisher: PublisherModule,
  client: DbClient,
  event: T,
  payload: EventPayload<T>,
): Promise<void> => {
  await publisher.publishWithRetry(client, event, payload)
}

describe('subject closer outbox subscriber', () => {
  let repo: string

  afterEach(() => {
    delete process.env.MARS_REPO
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('closes every matching Subject once when its declared terminal event arrives', async () => {
    repo = setupRepo()
    const { client, chat, closer, publisher } = await loadModules(repo)
    const first = await chat.createThread('First proposal', 'proposal.promoted', 'proposal-1')
    const second = await chat.createThread('Second proposal', 'proposal.promoted', 'proposal-1')
    const openEnded = await chat.createThread('Open question')

    await closer.ensureSubjectCloser(client)
    await publish(publisher, client, 'proposal.promoted', { proposalId: 'proposal-1' })
    await closer.drainSubjectCloser(client)

    const firstClosedAt = (await chat.getThread(first.id))!.thread.closed_at
    expect((await chat.getThread(first.id))!.thread.terminal_event_type).toBe('proposal.promoted')
    expect((await chat.getThread(first.id))!.thread.terminal_entity_id).toBe('proposal-1')
    expect(firstClosedAt).not.toBeNull()
    expect((await chat.getThread(second.id))!.thread.closed_at).not.toBeNull()
    expect((await chat.getThread(openEnded.id))!.thread.closed_at).toBeNull()

    await closer.drainSubjectCloser(client)
    expect((await chat.getThread(first.id))!.thread.closed_at).toBe(firstClosedAt)
  })
})
