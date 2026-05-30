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

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface RepopulatorModule {
  ACTION_QUEUE_REPOPULATOR_SUBSCRIBER: typeof import('../action-queue-repopulator').ACTION_QUEUE_REPOPULATOR_SUBSCRIBER
  ensureActionQueueRepopulator: typeof import('../action-queue-repopulator').ensureActionQueueRepopulator
  drainActionQueueRepopulations: typeof import('../action-queue-repopulator').drainActionQueueRepopulations
}

interface PublisherModule {
  publishWithRetry: typeof import('../../../bus/publisher').publishWithRetry
}

interface SubscribersModule {
  getCursor: typeof import('../../../bus/subscribers').getCursor
}

interface CatalogModule {
  loadFailureReasonCatalog: typeof import('../../lib/failure-reasons').loadFailureReasonCatalog
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
  rep: RepopulatorModule
  pub: PublisherModule
  subs: SubscribersModule
  catalog: Awaited<
    ReturnType<CatalogModule['loadFailureReasonCatalog']>
  >
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-action-queue-repopulator-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/**
 * Load all modules against the same temp repo. MARS_REPO makes resolveContext()
 * resolve stateDbPath/queueDbPath to one .mars/mars.db so events, action_queue_items,
 * and subscriber tables all share a single db.
 */
const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const rep = (await import(
    '../action-queue-repopulator'
  )) as unknown as RepopulatorModule
  const pub = (await import(
    '../../../bus/publisher'
  )) as unknown as PublisherModule
  const subs = (await import(
    '../../../bus/subscribers'
  )) as unknown as SubscribersModule
  const catalogMod = (await import(
    '../../lib/failure-reasons'
  )) as unknown as CatalogModule
  const catalog = await catalogMod.loadFailureReasonCatalog(
    resolve(repo, '.mars'),
  )
  return { q, actionQueue, rep, pub, subs, catalog }
}

const publish = async <T extends EventName>(
  pub: PublisherModule,
  client: Client,
  type: T,
  payload: EventPayload<T>,
): Promise<void> => {
  await pub.publishWithRetry(client, type, payload)
}

describe('action-queue-repopulator outbox subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('raises one open row on task.failed then supersedes it on task.queued (net zero open rows)', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-raise-evict'

    await rep.ensureActionQueueRepopulator(client)

    // ── Phase 1: task.failed → one open row
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p1).toBe(1)

    const openAfterFailed = await actionQueue.listActionQueueItems('open')
    expect(openAfterFailed.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(1)

    // ── Phase 2: task.queued → supersede, zero open rows for this origin
    await publish(pub, client, 'task.queued', { taskId })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p2).toBe(1)

    const openAfterQueued = await actionQueue.listActionQueueItems('open')
    expect(openAfterQueued.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('does not double-apply when drained again over already-processed events (processed-once)', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-idempotent'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })

    // First drain: raises the row
    const { processed: first } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(first).toBe(1)

    // Reset cursor to 0 so the subscriber sees the same event again.
    // processedOnce should prevent the sideEffect from running twice.
    await client.execute({
      sql: `UPDATE subscribers SET cursor = 0 WHERE name = ?`,
      args: [rep.ACTION_QUEUE_REPOPULATOR_SUBSCRIBER],
    })

    const { processed: second } = await rep.drainActionQueueRepopulations(client, catalog)
    // processedOnce suppresses the dedup slot — actionQueue mutation does not re-run
    expect(second).toBe(0)

    // Exactly one open row and seenCount=1 confirms raiseActionQueueItem was NOT
    // called a second time (which would have bumped seenCount to 2)
    const openItems = await actionQueue.listActionQueueItems('open')
    const taskItems = openItems.filter((i) => i.payload['taskId'] === taskId)
    expect(taskItems).toHaveLength(1)
    expect(taskItems[0].seenCount).toBe(1)
  })

  it('produces zero actionQueue rows for task.blocked (no prior failed row)', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-blocked'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'task.blocked', {
      taskId,
      fixTaskId: null,
      failureSignature: 'sig',
      failingStep: 'verify',
    })

    // task.blocked is now a mapped evict event (supersedes any prior failed row).
    // When no prior row exists the supersede is a no-op, but the event is still
    // counted as processed (handler returned true, cursor advances).
    const { processed } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('supersedes the failed row when a task transitions to blocked (regression: stale failed rows)', async () => {
    // Reproduce the scenario: task.failed raises a row, then a fix task is
    // spawned and the task transitions to blocked. The stale failed row must
    // be superseded so it does not surface as a spurious "needs attention" card.
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-failed-then-blocked'

    await rep.ensureActionQueueRepopulator(client)

    // Phase 1: task.failed → one open row
    await publish(pub, client, 'task.failed', { taskId, error: 'verify failed' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p1).toBe(1)
    expect(
      (await actionQueue.listActionQueueItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(1)

    // Phase 2: task.blocked → stale row must be superseded
    await publish(pub, client, 'task.blocked', {
      taskId,
      fixTaskId: 'fix-task-001',
      failureSignature: 'verify:test',
      failingStep: 'verify',
    })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p2).toBe(1)

    // Zero open rows — the stale failed row was superseded
    const openAfterBlocked = await actionQueue.listActionQueueItems('open')
    expect(openAfterBlocked.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.promoted', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const proposalId = 'prop-abc123'

    await rep.ensureActionQueueRepopulator(client)

    // proposal.added → raises one draft-proposal row
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'human',
      title: 'My great idea',
    })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p1).toBe(1)

    const openDraft = await actionQueue.listActionQueueItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(1)

    // proposal.promoted → evicts the draft-proposal row
    await publish(pub, client, 'proposal.promoted', { proposalId })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p2).toBe(1)

    const openDraftAfter = await actionQueue.listActionQueueItems('open', { kind: 'draft-proposal' })
    expect(openDraftAfter.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('advances cursor for unmapped events without creating actionQueue rows', async () => {
    const { q, actionQueue, rep, pub, subs, catalog } = await loadModules(repo)
    const client = q.getClient()

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'task.priority_changed', {
      taskId: 'T-unmapped',
      priority: 1,
    })

    const cursorBefore = await subs.getCursor(
      client,
      rep.ACTION_QUEUE_REPOPULATOR_SUBSCRIBER,
    )
    const { processed } = await rep.drainActionQueueRepopulations(client, catalog)
    const cursorAfter = await subs.getCursor(
      client,
      rep.ACTION_QUEUE_REPOPULATOR_SUBSCRIBER,
    )

    expect(processed).toBe(0)
    expect(cursorAfter).toBeGreaterThan(cursorBefore)

    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === 'T-unmapped')).toHaveLength(0)
  })

  it('evicts row on task.completed', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-completed'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'task.failed', { taskId, error: 'oops' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p1).toBe(1)

    expect(
      (await actionQueue.listActionQueueItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(1)

    await publish(pub, client, 'task.completed', { taskId, result: { status: 'done' } })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p2).toBe(1)

    expect(
      (await actionQueue.listActionQueueItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(0)
  })

  it('evicts row on task.unblocked', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-unblocked'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'task.failed', { taskId, error: 'oops' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p1).toBe(1)

    await publish(pub, client, 'task.unblocked', { taskId, blockerTaskId: 'B-1' })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p2).toBe(1)

    expect(
      (await actionQueue.listActionQueueItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.dismissed', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const proposalId = 'prop-dismissed'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'reflection',
      title: 'Dismissed idea',
    })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p1).toBe(1)

    await publish(pub, client, 'proposal.dismissed', { proposalId })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p2).toBe(1)

    const openDraft = await actionQueue.listActionQueueItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.deleted', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const proposalId = 'prop-deleted'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'planner',
      title: 'Deleted idea',
    })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p1).toBe(1)

    await publish(pub, client, 'proposal.deleted', { proposalId })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(p2).toBe(1)

    const openDraft = await actionQueue.listActionQueueItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  /**
   * Insert a tasks row directly via the client. Slice G's structured-row
   * branch reads `failure_reason_code`, `failure_reason`, `kind` and
   * `recovery_payload` off the row to decide which catalog entry to render
   * and whether to defer to F.2's aggregated writer.
   */
  const insertTaskRow = async (
    client: Client,
    row: {
      id: string
      failureReasonCode?: string | null
      failureReason?: string | null
      kind?: 'task' | 'fix' | 'diagnose'
      recoveryPayload?: string | null
    },
  ): Promise<void> => {
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (
              id, prompt, status, origin_id, retry_count,
              failure_reason, failure_reason_code,
              kind, recovery_payload,
              created_at, updated_at
            ) VALUES (?, ?, 'failed', ?, 0, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.id,
        '(test prompt)',
        row.id,
        row.failureReason ?? null,
        row.failureReasonCode ?? null,
        row.kind ?? 'task',
        row.recoveryPayload ?? null,
        now,
        now,
      ],
    })
  }

  it('renders the catalog entry when failure_reason_code is set on the task', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-typecheck-code'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      failureReasonCode: 'verify:typecheck',
      failureReason: 'verify:typecheck',
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'tsc failed' })
    const { processed } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    expect(row!.body).toContain('Type checks failed during verification.')
    expect(row!.body).toContain('**Available actions:**')
    // task-id substitution must run
    expect(row!.body).toContain(`mars restart ${taskId}`)
    expect(row!.body).toContain(`mars purge ${taskId}`)
    // payload carries the structured catalog entry
    expect(row!.payload['failureReasonCode']).toBe('verify:typecheck')
    expect(row!.payload['userMessage']).toBe(
      'Type checks failed during verification.',
    )
    expect(row!.payload['availableActions']).toBeDefined()
  })

  it('falls back through failureReasonStringToCode when only failure_reason is set', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-typecheck-legacy'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      failureReason: 'typecheck failed: 3 errors in queue.ts',
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'tsc failed' })
    const { processed } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    // Mapper resolves the loose string to verify:typecheck.
    expect(row!.body).toContain('Type checks failed during verification.')
    expect(row!.payload['failureReasonCode']).toBe('verify:typecheck')
  })

  it('renders the unknown catalog entry when both fields are null', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-unknown'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, { id: taskId })

    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    const { processed } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    expect(row!.body).toContain(
      'An unrecognised failure was recorded. Inspect the task transcript for details.',
    )
    // The `unknown` entry has the `investigate` action.
    expect(row!.body).toContain('Investigate')
    expect(row!.payload['failureReasonCode']).toBe('unknown')
  })

  it('does not raise the structured row for a failed main-commiter recovery', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-main-commiter-fix'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      kind: 'fix',
      recoveryPayload: JSON.stringify({
        recipe: 'main-commiter',
        dirtyMainHash: 'abc123',
        integrationBranch: 'main',
      }),
      failureReasonCode: 'verify:main-dirty',
      failureReason: 'verify:main-dirty',
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'commit failed' })
    const { processed } = await rep.drainActionQueueRepopulations(client, catalog)
    // The event was claimed (processedOnce committed) but the structured
    // writer early-returned, so no actionQueue row was raised by action-queue-repopulator.
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('renders the catalog entry on task.dropped too', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-dropped'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      failureReasonCode: 'code:timeout',
      failureReason: 'code:timeout',
    })

    await publish(pub, client, 'task.dropped', {
      taskId,
      dropReason: 'user skipped',
    })
    const { processed } = await rep.drainActionQueueRepopulations(client, catalog)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    expect(row!.body).toContain(
      'The coder did not finish within its time budget.',
    )
    expect(row!.payload['failureReasonCode']).toBe('code:timeout')
  })

  it('never emits the legacy "without a specific recovery plan" fallback', async () => {
    const { q, actionQueue, rep, pub, catalog } = await loadModules(repo)
    const client = q.getClient()
    const taskId = 'T-legacy-template-check'

    await rep.ensureActionQueueRepopulator(client)
    // No task row inserted at all; getTask returns null and we still render
    // the `unknown` catalog entry rather than the old hardcoded template.
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    await rep.drainActionQueueRepopulations(client, catalog)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    expect(row!.body).not.toContain('without a specific recovery plan')
    expect(row!.body).not.toContain('Inspect the full log with')
  })
})
