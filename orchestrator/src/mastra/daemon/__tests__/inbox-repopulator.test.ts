import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'
import type { EventName, EventPayload } from '../../../bus/events.js'

interface QueueModule {
  initQueue: typeof import('../../queue').initQueue
  getClient: typeof import('../../queue').getClient
}

interface InboxModule {
  listInboxItems: typeof import('../../lib/inbox').listInboxItems
}

interface RepopulatorModule {
  INBOX_REPOPULATOR_SUBSCRIBER: typeof import('../inbox-repopulator').INBOX_REPOPULATOR_SUBSCRIBER
  ensureInboxRepopulator: typeof import('../inbox-repopulator').ensureInboxRepopulator
  drainInboxRepopulations: typeof import('../inbox-repopulator').drainInboxRepopulations
}

interface PublisherModule {
  publishWithRetry: typeof import('../../../bus/publisher').publishWithRetry
}

interface SubscribersModule {
  getCursor: typeof import('../../../bus/subscribers').getCursor
}

interface Loaded {
  q: QueueModule
  inbox: InboxModule
  rep: RepopulatorModule
  pub: PublisherModule
  subs: SubscribersModule
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-inbox-repopulator-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Load all modules against the same temp repo. MARS_REPO makes resolveContext()
 * resolve stateDbPath/queueDbPath to one .mars/mars.db so events, inbox_items,
 * and subscriber tables all share a single db.
 */
const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const inbox = (await import('../../lib/inbox')) as unknown as InboxModule
  const rep = (await import(
    '../inbox-repopulator'
  )) as unknown as RepopulatorModule
  const pub = (await import(
    '../../../bus/publisher'
  )) as unknown as PublisherModule
  const subs = (await import(
    '../../../bus/subscribers'
  )) as unknown as SubscribersModule
  return { q, inbox, rep, pub, subs }
}

const publish = async <T extends EventName>(
  pub: PublisherModule,
  client: Client,
  type: T,
  payload: EventPayload<T>,
): Promise<void> => {
  await pub.publishWithRetry(client, type, payload)
}

describe('inbox-repopulator outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises one open row on task.failed then supersedes it on task.queued (net zero open rows)', async () => {
    const { q, inbox, rep, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-raise-evict'

    await rep.ensureInboxRepopulator(client)

    // ── Phase 1: task.failed → one open row
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    const { processed: p1 } = await rep.drainInboxRepopulations(client)
    expect(p1).toBe(1)

    const openAfterFailed = await inbox.listInboxItems('open')
    expect(openAfterFailed.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(1)

    // ── Phase 2: task.queued → supersede, zero open rows for this origin
    await publish(pub, client, 'task.queued', { taskId })
    const { processed: p2 } = await rep.drainInboxRepopulations(client)
    expect(p2).toBe(1)

    const openAfterQueued = await inbox.listInboxItems('open')
    expect(openAfterQueued.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('does not double-apply when drained again over already-processed events (processed-once)', async () => {
    const { q, inbox, rep, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-idempotent'

    await rep.ensureInboxRepopulator(client)
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })

    // First drain: raises the row
    const { processed: first } = await rep.drainInboxRepopulations(client)
    expect(first).toBe(1)

    // Reset cursor to 0 so the subscriber sees the same event again.
    // processedOnce should prevent the sideEffect from running twice.
    await client.execute({
      sql: `UPDATE subscribers SET cursor = 0 WHERE name = ?`,
      args: [rep.INBOX_REPOPULATOR_SUBSCRIBER],
    })

    const { processed: second } = await rep.drainInboxRepopulations(client)
    // processedOnce suppresses the dedup slot — inbox mutation does not re-run
    expect(second).toBe(0)

    // Exactly one open row and seenCount=1 confirms raiseInboxItem was NOT
    // called a second time (which would have bumped seenCount to 2)
    const openItems = await inbox.listInboxItems('open')
    const taskItems = openItems.filter((i) => i.payload['taskId'] === taskId)
    expect(taskItems).toHaveLength(1)
    expect(taskItems[0].seenCount).toBe(1)
  })

  it('produces zero inbox rows for task.blocked', async () => {
    const { q, inbox, rep, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-blocked'

    await rep.ensureInboxRepopulator(client)
    await publish(pub, client, 'task.blocked', {
      taskId,
      fixTaskId: null,
      failureSignature: 'sig',
      failingStep: 'verify',
    })

    const { processed } = await rep.drainInboxRepopulations(client)
    expect(processed).toBe(0)

    const openItems = await inbox.listInboxItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.promoted', async () => {
    const { q, inbox, rep, pub } = await loadModules(repo)
    const client = q.getClient()
    const proposalId = 'prop-abc123'

    await rep.ensureInboxRepopulator(client)

    // proposal.added → raises one draft-proposal row
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'human',
      title: 'My great idea',
    })
    const { processed: p1 } = await rep.drainInboxRepopulations(client)
    expect(p1).toBe(1)

    const openDraft = await inbox.listInboxItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(1)

    // proposal.promoted → evicts the draft-proposal row
    await publish(pub, client, 'proposal.promoted', { proposalId })
    const { processed: p2 } = await rep.drainInboxRepopulations(client)
    expect(p2).toBe(1)

    const openDraftAfter = await inbox.listInboxItems('open', { kind: 'draft-proposal' })
    expect(openDraftAfter.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('advances cursor for unmapped events without creating inbox rows', async () => {
    const { q, inbox, rep, pub, subs } = await loadModules(repo)
    const client = q.getClient()

    await rep.ensureInboxRepopulator(client)
    await publish(pub, client, 'task.priority_changed', {
      taskId: 'T-unmapped',
      priority: 1,
    })

    const cursorBefore = await subs.getCursor(
      client,
      rep.INBOX_REPOPULATOR_SUBSCRIBER,
    )
    const { processed } = await rep.drainInboxRepopulations(client)
    const cursorAfter = await subs.getCursor(
      client,
      rep.INBOX_REPOPULATOR_SUBSCRIBER,
    )

    expect(processed).toBe(0)
    expect(cursorAfter).toBeGreaterThan(cursorBefore)

    const openItems = await inbox.listInboxItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === 'T-unmapped')).toHaveLength(0)
  })

  it('evicts row on task.completed', async () => {
    const { q, inbox, rep, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-completed'

    await rep.ensureInboxRepopulator(client)
    await publish(pub, client, 'task.failed', { taskId, error: 'oops' })
    const { processed: p1 } = await rep.drainInboxRepopulations(client)
    expect(p1).toBe(1)

    expect(
      (await inbox.listInboxItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(1)

    await publish(pub, client, 'task.completed', { taskId, result: { status: 'done' } })
    const { processed: p2 } = await rep.drainInboxRepopulations(client)
    expect(p2).toBe(1)

    expect(
      (await inbox.listInboxItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(0)
  })

  it('evicts row on task.unblocked', async () => {
    const { q, inbox, rep, pub } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-unblocked'

    await rep.ensureInboxRepopulator(client)
    await publish(pub, client, 'task.failed', { taskId, error: 'oops' })
    const { processed: p1 } = await rep.drainInboxRepopulations(client)
    expect(p1).toBe(1)

    await publish(pub, client, 'task.unblocked', { taskId, blockerTaskId: 'B-1' })
    const { processed: p2 } = await rep.drainInboxRepopulations(client)
    expect(p2).toBe(1)

    expect(
      (await inbox.listInboxItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.dismissed', async () => {
    const { q, inbox, rep, pub } = await loadModules(repo)
    const client = q.getClient()
    const proposalId = 'prop-dismissed'

    await rep.ensureInboxRepopulator(client)
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'reflection',
      title: 'Dismissed idea',
    })
    const { processed: p1 } = await rep.drainInboxRepopulations(client)
    expect(p1).toBe(1)

    await publish(pub, client, 'proposal.dismissed', { proposalId })
    const { processed: p2 } = await rep.drainInboxRepopulations(client)
    expect(p2).toBe(1)

    const openDraft = await inbox.listInboxItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.deleted', async () => {
    const { q, inbox, rep, pub } = await loadModules(repo)
    const client = q.getClient()
    const proposalId = 'prop-deleted'

    await rep.ensureInboxRepopulator(client)
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'planner',
      title: 'Deleted idea',
    })
    const { processed: p1 } = await rep.drainInboxRepopulations(client)
    expect(p1).toBe(1)

    await publish(pub, client, 'proposal.deleted', { proposalId })
    const { processed: p2 } = await rep.drainInboxRepopulations(client)
    expect(p2).toBe(1)

    const openDraft = await inbox.listInboxItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })
})
