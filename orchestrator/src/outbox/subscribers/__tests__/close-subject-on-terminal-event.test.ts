import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../../core/lib/db.js'
import type { EventName, EventPayload } from '../../../bus/events.js'

interface QueueModule {
  ensureQueueSchema: typeof import('../../../core/queue').ensureQueueSchema
  resolveQueueClient: typeof import('../../../core/queue').resolveQueueClient
}

interface ChatStoreModule {
  createThread: typeof import('../../../core/lib/chat-store').createThread
  getThread: typeof import('../../../core/lib/chat-store').getThread
}

interface SubscriberModule {
  ensureCloseSubjectOnTerminalEventSubscriber: typeof import('../close-subject-on-terminal-event').ensureCloseSubjectOnTerminalEventSubscriber
  drainCloseSubjectOnTerminalEvent: typeof import('../close-subject-on-terminal-event').drainCloseSubjectOnTerminalEvent
}

interface PublisherModule {
  publishWithRetry: typeof import('../../../bus/publisher').publishWithRetry
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-close-subject-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<{
  client: DbClient
  chat: ChatStoreModule
  subscriber: SubscriberModule
  publisher: PublisherModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../../core/queue')) as unknown as QueueModule
  await queue.ensureQueueSchema()
  return {
    client: queue.resolveQueueClient(),
    chat: (await import('../../../core/lib/chat-store')) as unknown as ChatStoreModule,
    subscriber: (await import('../close-subject-on-terminal-event')) as unknown as SubscriberModule,
    publisher: (await import('../../../bus/publisher')) as unknown as PublisherModule,
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

describe('close-subject-on-terminal-event outbox subscriber', () => {
  let repo: string

  afterEach(() => {
    delete process.env.MARS_REPO
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('evaporates only the Subject whose declared terminal event and entity arrive', async () => {
    repo = setupRepo()
    const { client, chat, subscriber, publisher } = await loadModules(repo)
    const matching = await chat.createThread(
      'Prepare the matching proposal',
      'proposal.promoted',
      'proposal-matching',
    )
    const other = await chat.createThread(
      'Keep this proposal open',
      'proposal.promoted',
      'proposal-other',
    )

    await subscriber.ensureCloseSubjectOnTerminalEventSubscriber(client)
    await publish(publisher, client, 'proposal.promoted', { proposalId: 'proposal-matching' })
    await subscriber.drainCloseSubjectOnTerminalEvent(client)

    expect((await chat.getThread(matching.id))?.thread.closed_at).not.toBeNull()
    expect((await chat.getThread(other.id))?.thread.closed_at).toBeNull()
  })

  it('leaves a Subject open when a different terminal event arrives', async () => {
    repo = setupRepo()
    const { client, chat, subscriber, publisher } = await loadModules(repo)
    const subject = await chat.createThread(
      'Prepare a proposal',
      'proposal.promoted',
      'proposal-unchanged',
    )

    await subscriber.ensureCloseSubjectOnTerminalEventSubscriber(client)
    await publish(publisher, client, 'proposal.dismissed', { proposalId: 'proposal-unchanged' })
    await subscriber.drainCloseSubjectOnTerminalEvent(client)

    expect((await chat.getThread(subject.id))?.thread.closed_at).toBeNull()
  })
})
