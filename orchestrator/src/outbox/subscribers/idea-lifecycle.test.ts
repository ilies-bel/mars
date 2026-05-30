import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  initQueue: typeof import('../../mastra/queue').initQueue
  getClient: typeof import('../../mastra/queue').getClient
}

interface IdeaLifecycleModule {
  IDEA_LIFECYCLE_SUBSCRIBER: typeof import('./idea-lifecycle').IDEA_LIFECYCLE_SUBSCRIBER
  ensureIdeaLifecycleSubscriber: typeof import('./idea-lifecycle').ensureIdeaLifecycleSubscriber
  drainIdeaLifecycle: typeof import('./idea-lifecycle').drainIdeaLifecycle
}

interface PublisherModule {
  publishWithRetry: typeof import('../../bus/publisher').publishWithRetry
}

interface Loaded {
  q: QueueModule
  sub: IdeaLifecycleModule
  pub: PublisherModule
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-idea-lifecycle-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../mastra/queue')) as unknown as QueueModule
  await q.initQueue()
  const sub = (await import('./idea-lifecycle')) as unknown as IdeaLifecycleModule
  const pub = (await import('../../bus/publisher')) as unknown as PublisherModule
  return { q, sub, pub }
}

describe('idea-lifecycle outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('processes a proposal.added event — exactly one event per transition', async () => {
    // AC1: each idea lifecycle transition emits exactly one Outbox event,
    // and the subscriber consumes it once.
    const { q, sub, pub } = await loadModules(repo)
    await sub.ensureIdeaLifecycleSubscriber(q.getClient())
    await pub.publishWithRetry(q.getClient(), 'proposal.added', {
      proposalId: 'prop-1',
      source: 'human',
      title: 'My idea',
    })

    const { processed } = await sub.drainIdeaLifecycle(q.getClient())

    expect(processed).toBe(1)
  })

  it('processes proposal.promoted, proposal.dismissed, and proposal.deleted transitions', async () => {
    // AC1: all four lifecycle transitions (added is covered above) are consumed.
    const { q, sub, pub } = await loadModules(repo)
    await sub.ensureIdeaLifecycleSubscriber(q.getClient())

    await pub.publishWithRetry(q.getClient(), 'proposal.promoted', { proposalId: 'prop-p' })
    await pub.publishWithRetry(q.getClient(), 'proposal.dismissed', { proposalId: 'prop-d' })
    await pub.publishWithRetry(q.getClient(), 'proposal.deleted', { proposalId: 'prop-del' })

    const { processed } = await sub.drainIdeaLifecycle(q.getClient())

    expect(processed).toBe(3)
  })

  it('ignores non-lifecycle proposal events (e.g. proposal.sliced)', async () => {
    // The subscriber only reacts to the four lifecycle transitions; other
    // proposal events (sliced, updated, story_added, …) pass through unhandled.
    const { q, sub, pub } = await loadModules(repo)
    await sub.ensureIdeaLifecycleSubscriber(q.getClient())

    await pub.publishWithRetry(q.getClient(), 'proposal.sliced', {
      proposalId: 'prop-s',
      taskCount: 3,
    })

    const { processed } = await sub.drainIdeaLifecycle(q.getClient())

    expect(processed).toBe(0)
  })

  it('replays missed lifecycle events after a daemon restart (cursor-based recovery)', async () => {
    // AC2: a subscriber that registered before an event was published, then
    // "crashed" without draining, still picks up the event on the next drain
    // — the cursor is preserved across simulated restarts.
    const { q, sub, pub } = await loadModules(repo)

    // Register before the event — cursor is placed at the current outbox head.
    await sub.ensureIdeaLifecycleSubscriber(q.getClient())

    // Publish an event that the subscriber would miss due to a crash.
    await pub.publishWithRetry(q.getClient(), 'proposal.added', {
      proposalId: 'prop-restart',
      source: 'reflection',
      title: 'Restart idea',
    })

    // Simulate daemon crash: do NOT drain. Re-registering is a no-op;
    // the cursor position is preserved.
    await sub.ensureIdeaLifecycleSubscriber(q.getClient())

    // Drain on "restart" — the event is replayed from the cursor position.
    const { processed } = await sub.drainIdeaLifecycle(q.getClient())

    expect(processed).toBe(1)
  })

  it('fires exactly once per transition — draining the same event twice is idempotent', async () => {
    // AC2: even if the daemon drains repeatedly, each lifecycle event is
    // counted and side-effected at most once (cursor advances after first drain).
    const { q, sub, pub } = await loadModules(repo)
    await sub.ensureIdeaLifecycleSubscriber(q.getClient())
    await pub.publishWithRetry(q.getClient(), 'proposal.added', {
      proposalId: 'prop-idem',
      source: 'human',
      title: 'Idempotent idea',
    })

    const first = await sub.drainIdeaLifecycle(q.getClient())
    const second = await sub.drainIdeaLifecycle(q.getClient())

    expect(first.processed).toBe(1)
    expect(second.processed).toBe(0) // cursor already advanced; no pending events
  })

  it('mixed bag: counts only lifecycle events, ignores others in the same drain', async () => {
    const { q, sub, pub } = await loadModules(repo)
    await sub.ensureIdeaLifecycleSubscriber(q.getClient())

    // Two lifecycle events interleaved with one non-lifecycle event.
    await pub.publishWithRetry(q.getClient(), 'proposal.added', {
      proposalId: 'prop-m1',
      source: 'human',
      title: 'First',
    })
    await pub.publishWithRetry(q.getClient(), 'proposal.sliced', {
      proposalId: 'prop-m1',
      taskCount: 2,
    })
    await pub.publishWithRetry(q.getClient(), 'proposal.promoted', {
      proposalId: 'prop-m1',
    })

    const { processed } = await sub.drainIdeaLifecycle(q.getClient())

    expect(processed).toBe(2) // added + promoted; sliced is not a lifecycle event
  })
})
