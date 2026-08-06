import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Client } from '@libsql/client'
import type { EventName, EventPayload } from '../../../bus/events.js'
// Assert against the exported label rather than a copy of its text: the older
// wording ('A pipeline step did not complete') is retained in failure-kinds.ts
// only so the view can REPLACE it on legacy rows, and hardcoding it here made
// these tests assert superseded copy.
import { GENERIC_FAILURE_LABEL } from '../../lib/failure-kinds.js'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  supersedeActionQueueItemsForOrigin: typeof import('../../lib/action-queue').supersedeActionQueueItemsForOrigin
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

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
  rep: RepopulatorModule
  pub: PublisherModule
  subs: SubscribersModule
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
  await q.migrateQueueSchema()
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
  return { q, actionQueue, rep, pub, subs }
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
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-raise-evict'

    await rep.ensureActionQueueRepopulator(client)
    // Insert a task row so getTask returns non-null (task exists in 'failed' state).
    await insertTaskRow(client, { id: taskId })

    // ── Phase 1: task.failed → one open row
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)

    const openAfterFailed = await actionQueue.listActionQueueItems('open')
    expect(openAfterFailed.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(1)

    // ── Phase 2: task.queued → supersede, zero open rows for this origin
    await publish(pub, client, 'task.queued', { taskId })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    const openAfterQueued = await actionQueue.listActionQueueItems('open')
    expect(openAfterQueued.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('does not double-apply when drained again over already-processed events (processed-once)', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-idempotent'

    await rep.ensureActionQueueRepopulator(client)
    // Task row must exist so getTask returns non-null and the row is raised.
    await insertTaskRow(client, { id: taskId })
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })

    // First drain: raises the row
    const { processed: first } = await rep.drainActionQueueRepopulations(client)
    expect(first).toBe(1)

    // Reset cursor to 0 so the subscriber sees the same event again.
    // processedOnce should prevent the sideEffect from running twice.
    await client.execute({
      sql: `UPDATE subscribers SET cursor = 0 WHERE name = ?`,
      args: [rep.ACTION_QUEUE_REPOPULATOR_SUBSCRIBER],
    })

    const { processed: second } = await rep.drainActionQueueRepopulations(client)
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
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
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
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('supersedes the failed row when a task transitions to blocked (regression: stale failed rows)', async () => {
    // Reproduce the scenario: task.failed raises a row, then a fix task is
    // spawned and the task transitions to blocked. The stale failed row must
    // be superseded so it does not surface as a spurious "needs attention" card.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-failed-then-blocked'

    await rep.ensureActionQueueRepopulator(client)
    // Task row must exist so getTask returns non-null and the row is raised.
    await insertTaskRow(client, { id: taskId })

    // Phase 1: task.failed → one open row
    await publish(pub, client, 'task.failed', { taskId, error: 'verify failed' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
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
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    // Zero open rows — the stale failed row was superseded
    const openAfterBlocked = await actionQueue.listActionQueueItems('open')
    expect(openAfterBlocked.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.promoted', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const proposalId = 'prop-abc123'

    await rep.ensureActionQueueRepopulator(client)

    // proposal.added → raises one draft-proposal row
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'human',
      title: 'My great idea',
    })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)

    const openDraft = await actionQueue.listActionQueueItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(1)

    // proposal.promoted → evicts the draft-proposal row
    await publish(pub, client, 'proposal.promoted', { proposalId })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    const openDraftAfter = await actionQueue.listActionQueueItems('open', { kind: 'draft-proposal' })
    expect(openDraftAfter.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('advances cursor for unmapped events without creating actionQueue rows', async () => {
    const { q, actionQueue, rep, pub, subs } = await loadModules(repo)
    const client = q.resolveQueueClient()

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'task.priority_changed', {
      taskId: 'T-unmapped',
      priority: 1,
    })

    const cursorBefore = await subs.getCursor(
      client,
      rep.ACTION_QUEUE_REPOPULATOR_SUBSCRIBER,
    )
    const { processed } = await rep.drainActionQueueRepopulations(client)
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
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-completed'

    await rep.ensureActionQueueRepopulator(client)
    // Task row must exist so getTask returns non-null and the initial row is raised.
    await insertTaskRow(client, { id: taskId })
    await publish(pub, client, 'task.failed', { taskId, error: 'oops' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)

    expect(
      (await actionQueue.listActionQueueItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(1)

    await publish(pub, client, 'task.completed', { taskId, result: { status: 'done' } })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    expect(
      (await actionQueue.listActionQueueItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(0)
  })

  it('evicts row on task.unblocked', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-unblocked'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'task.failed', { taskId, error: 'oops' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)

    await publish(pub, client, 'task.unblocked', { taskId, blockerTaskId: 'B-1' })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    expect(
      (await actionQueue.listActionQueueItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.dismissed', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const proposalId = 'prop-dismissed'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'reflection',
      title: 'Dismissed idea',
    })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)

    await publish(pub, client, 'proposal.dismissed', { proposalId })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    const openDraft = await actionQueue.listActionQueueItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('nets zero open draft rows: proposal.added then proposal.deleted', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const proposalId = 'prop-deleted'

    await rep.ensureActionQueueRepopulator(client)
    await publish(pub, client, 'proposal.added', {
      proposalId,
      source: 'planner',
      title: 'Deleted idea',
    })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)

    await publish(pub, client, 'proposal.deleted', { proposalId })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    const openDraft = await actionQueue.listActionQueueItems('open', { kind: 'draft-proposal' })
    expect(openDraft.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  /**
   * Insert a tasks row directly via the client. The repopulator reads
   * `failure_signature`, `failure_reason_code`, `failure_reason`, `kind`,
   * `recovery_payload`, and `error` off the row to decide which Failure kind
   * entry and catalog entry to use, and whether to defer to F.2's aggregated
   * writer.
   */
  const insertTaskRow = async (
    client: Client,
    row: {
      id: string
      failureReasonCode?: string | null
      failureReason?: string | null
      kind?: 'task' | 'fix' | 'diagnose'
      recoveryPayload?: string | null
      /** The `<failingStep>/<error-class>` signature from the Failure kind registry. */
      failureSignature?: string | null
      /** Captured error output used as the verboseReason hint for unknown kinds. */
      error?: string | null
    },
  ): Promise<void> => {
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (
              id, prompt, status, origin_id, retry_count,
              failure_reason, failure_reason_code,
              kind, recovery_payload,
              failure_signature, error,
              created_at, updated_at
            ) VALUES (?, ?, 'failed', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.id,
        '(test prompt)',
        row.id,
        row.failureReason ?? null,
        row.failureReasonCode ?? null,
        row.kind ?? 'task',
        row.recoveryPayload ?? null,
        row.failureSignature ?? null,
        row.error ?? null,
        now,
        now,
      ],
    })
  }

  it('derives title and body from the Failure kind registry when failureSignature is set', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-typecheck-code'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      failureSignature: 'verify:typecheck/typecheck-cannot-find-name',
      failureReasonCode: 'verify:typecheck',
      failureReason: 'verify:typecheck',
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'tsc failed' })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    // title and body come from the single Failure kind record keyed on
    // signature; the title also carries the signature and the failed task's
    // short id so a queue of failures is triageable row by row.
    expect(row!.title).toBe(
      'verify:typecheck/typecheck-cannot-find-name — The changes did not pass type-checking [task T-typech]',
    )
    expect(row!.body).toBe(
      'The verify step failed because the code references a name that is not in scope (TS2304).',
    )
    // ADR-0042: failureReasonCode now mirrors the resolved signature, and the
    // action menu carries the Failure kind's ops (no separate catalog).
    expect(row!.payload['failureReasonCode']).toBe(
      'verify:typecheck/typecheck-cannot-find-name',
    )
    expect(row!.payload['failureSignature']).toBe(
      'verify:typecheck/typecheck-cannot-find-name',
    )
    expect(row!.payload['availableActions']).toBeDefined()
  })

  it('falls back to unknownFailureKind when only failure_reason is set (no failureSignature)', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-typecheck-legacy'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      failureReason: 'typecheck failed: 3 errors in queue.ts',
      // No failureSignature — resolution falls through to unknownFailureKind
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'tsc failed' })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    // Without a structured signature, resolveFailureKind synthesises an
    // unknown record (signature `unknown/unknown`) rather than re-grepping the
    // raw string into a coarse catalog code (the ADR-0042 bug fix).
    // The fallback emits plain-English text — no raw step ids.
    expect(row!.payload['failureReasonCode']).toBe('unknown/unknown')
    expect(row!.title).toContain(GENERIC_FAILURE_LABEL)
  })

  it('uses unknownFailureKind title/body when failureSignature and reason code are both absent', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-unknown'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, { id: taskId })

    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    // No failureSignature and no captured error → the generic wording, which
    // is the genuine last resort. It still names the task.
    // The fallback emits plain-English text — no raw step ids ('unknown').
    expect(row!.title).toBe(`${GENERIC_FAILURE_LABEL} [task T-unknow]`)
    // Body is the verboseReason from unknownFailureKind.
    expect(row!.body).toContain(GENERIC_FAILURE_LABEL)
    // Payload's failureReasonCode mirrors the synthesised unknown signature.
    expect(row!.payload['failureReasonCode']).toBe('unknown/unknown')
  })

  it('does not raise the structured row for a failed main-commiter recovery', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-main-commiter-fix'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      kind: 'fix',
      recoveryPayload: JSON.stringify({
        recipe: 'main-commiter',
        integrationBranch: 'main',
      }),
      failureReasonCode: 'verify:main-dirty',
      failureReason: 'verify:main-dirty',
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'commit failed' })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    // The event was claimed (processedOnce committed) but the structured
    // writer early-returned, so no actionQueue row was raised by action-queue-repopulator.
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('does not raise a repopulator row for a generic fix task (recoveryPayload=null)', async () => {
    // A generic (non-main-commiter) recovery task (kind='fix', recoveryPayload=null)
    // that fails must NOT produce a repopulator row. The origin-keyed escalation row
    // raised by handleTaskFailureWithFixTask is the single owner of the arc alert.
    // Previously the narrow isMainCommiterRecovery gate let this case through, causing
    // a second row keyed on the fix task's own id (lineage audit findings #5 + #7).
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-generic-fix'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      kind: 'fix',
      recoveryPayload: null,
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'coder failed' })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    // The event is consumed (cursor advances, processedOnce commits) …
    expect(processed).toBe(1)
    // … but no action-queue row is raised — the repopulator returns early for
    // all fix tasks, leaving the origin-keyed escalation row as the sole alert.
    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('derives Failure kind title/body on task.dropped too', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-dropped'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      failureSignature: 'code:timeout/install-timeout',
      failureReasonCode: 'code:timeout',
      failureReason: 'code:timeout',
    })

    await publish(pub, client, 'task.dropped', {
      taskId,
      dropReason: 'user skipped',
    })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    // title and body from Failure kind registry, with the signature and the
    // task id folded into the title
    expect(row!.title).toBe(
      'code:timeout/install-timeout — The coder took too long [task T-droppe]',
    )
    expect(row!.body).toContain('SIGKILL / exit 137')
    // payload's failureReasonCode mirrors the resolved signature
    expect(row!.payload['failureReasonCode']).toBe('code:timeout/install-timeout')
  })

  it('raises no row for a task.failed event when the task row does not exist (guard against orphaned rows)', async () => {
    // When getTask returns null the task has been purged/deleted. Raising a
    // row for a non-existent task would create an orphaned action-queue item
    // that can never be closed — the Invalidator already ran its close pass
    // before this event was processed. The repopulator must skip raising.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-no-task-row'

    await rep.ensureActionQueueRepopulator(client)
    // No task row inserted; getTask returns null.
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    // processed=1 because the event is consumed (cursor advances), but no
    // row is raised — returning early counts as handling the event.
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('does not raise a failed row when the task has been purged before the repopulator drains (race fix)', async () => {
    // Regression: mars unblock → mars purge can leave a permanent zombie
    // 'failed' action-queue row. The event sequence is:
    //   task.failed (4477) → task.terminal{purged} (4480) → action-queue.raised (4481)
    // The Invalidator's close pass (driven by 4480) runs BEFORE the row exists
    // (4481), so the row is never closed. This test verifies the fix: if the
    // task row has been deleted (purged) by the time the repopulator processes
    // task.failed, no row is raised at all.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-purged-before-drain'

    await rep.ensureActionQueueRepopulator(client)

    // Step 1: Insert the task row (simulating a task in failed state)
    await insertTaskRow(client, { id: taskId, error: 'verify failed' })

    // Step 2: Publish task.failed but do NOT drain the repopulator yet
    await publish(pub, client, 'task.failed', { taskId, error: 'verify failed' })

    // Step 3: Simulate purge — delete the task row exactly as dropTask does
    await client.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [taskId] })

    // Step 4: Drain the repopulator (processes task.failed, but task is gone)
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1) // event is consumed; cursor advances

    // No open row: task was purged before the repopulator ran, so raising
    // a row that can never be closed is correctly skipped.
    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('auto-closes slices-dropped row when the proposal is promoted', async () => {
    // Mirrors the draft-proposal eviction test. slices-dropped rows are keyed
    // to the proposal via originTaskId, so supersedeActionQueueItemsForOrigin
    // (called by the repopulator on proposal.promoted) closes them automatically.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const proposalId = 'prop-slices-dropped-promoted'

    await rep.ensureActionQueueRepopulator(client)

    // Raise the slices-dropped row directly (as the slicer does in production).
    await actionQueue.raiseActionQueueItem({
      kind: 'slices-dropped',
      category: 'orchestrator',
      priority: 'normal',
      title: `Slicer pre-flight: 2 slices already satisfied for PRD ${proposalId}`,
      body: `PRD ${proposalId}: 2 slices were dropped as already satisfied on main.`,
      payload: { proposalId, droppedCount: 2, survivorCount: 1 },
      context: {},
      raisedBy: 'slicer',
      signature: proposalId,
      originTaskId: proposalId,
    })

    const openBefore = await actionQueue.listActionQueueItems('open', { kind: 'slices-dropped' })
    expect(openBefore.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(1)

    // proposal.promoted → repopulator calls supersedeActionQueueItemsForOrigin(proposalId)
    // which closes ALL open rows keyed to this origin, including slices-dropped.
    await publish(pub, client, 'proposal.promoted', { proposalId })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openAfter = await actionQueue.listActionQueueItems('open', { kind: 'slices-dropped' })
    expect(openAfter.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('auto-closes slices-dropped row when the proposal is dismissed', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const proposalId = 'prop-slices-dropped-dismissed'

    await rep.ensureActionQueueRepopulator(client)

    await actionQueue.raiseActionQueueItem({
      kind: 'slices-dropped',
      category: 'orchestrator',
      priority: 'normal',
      title: `Slicer pre-flight: 1 slice already satisfied for PRD ${proposalId}`,
      body: `PRD ${proposalId}: 1 slice was dropped as already satisfied on main.`,
      payload: { proposalId, droppedCount: 1, survivorCount: 3 },
      context: {},
      raisedBy: 'slicer',
      signature: proposalId,
      originTaskId: proposalId,
    })

    await publish(pub, client, 'proposal.dismissed', { proposalId })
    await rep.drainActionQueueRepopulations(client)

    const openAfter = await actionQueue.listActionQueueItems('open', { kind: 'slices-dropped' })
    expect(openAfter.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('auto-closes slice-failed row when the proposal is dismissed', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const proposalId = 'prop-slice-failed-dismissed'

    await rep.ensureActionQueueRepopulator(client)
    await actionQueue.raiseActionQueueItem({
      kind: 'slice-failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Slicer failed for PRD ${proposalId}`,
      body: 'The slicer rejected the PRD.',
      payload: { proposalId, error: 'invalid slice references' },
      context: {},
      raisedBy: 'slicer',
      signature: proposalId,
      originTaskId: proposalId,
    })

    await publish(pub, client, 'proposal.dismissed', { proposalId })
    await rep.drainActionQueueRepopulations(client)

    const openAfter = await actionQueue.listActionQueueItems('open', { kind: 'slice-failed' })
    expect(openAfter.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  it('auto-closes slice-failed row when the proposal is sliced after an explicit retry', async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const proposalId = 'prop-slice-failed-retried'

    await rep.ensureActionQueueRepopulator(client)
    await actionQueue.raiseActionQueueItem({
      kind: 'slice-failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Slicer failed for PRD ${proposalId}`,
      body: 'The slicer rejected the PRD.',
      payload: { proposalId, error: 'invalid slice references' },
      context: {},
      raisedBy: 'slicer',
      signature: proposalId,
      originTaskId: proposalId,
    })

    await publish(pub, client, 'proposal.sliced', { proposalId, taskCount: 1 })
    await rep.drainActionQueueRepopulations(client)

    const openAfter = await actionQueue.listActionQueueItems('open', { kind: 'slice-failed' })
    expect(openAfter.filter((i) => i.payload['proposalId'] === proposalId)).toHaveLength(0)
  })

  // ── Failure kind registry acceptance criteria ─────────────────────────────

  it("task with signature 'setup:install/install-frozen-lockfile' produces title 'The coding environment could not be set up'", async () => {
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-setup-lockfile'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      failureSignature: 'setup:install/install-frozen-lockfile',
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'install failed' })
    await rep.drainActionQueueRepopulations(client)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    // The warm reason still comes from the registry, prefixed by the signature
    // and suffixed with the task id so sibling failures stay distinguishable.
    expect(row!.title).toBe(
      'setup:install/install-frozen-lockfile — The coding environment could not be set up [task T-setup-]',
    )
  })

  it("task with unregistered signature 'verify:test/unclassified' produces a plain-English verification reason", async () => {
    // verify:test/unclassified is intentionally not in the registry (each test
    // failure has a unique root cause). The fallback maps verify:* steps to a
    // human-readable reason. The raw signature must NOT lead the title:
    // `unknownFailureKind` is explicit that a raw step id "must NOT appear in
    // user-facing fields; it belongs in transcripts and traces only". The
    // signature stays available to the operator on the row's payload
    // (failureReasonCode), which is where a machine-readable id belongs.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-verify-test-unclassified'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, {
      id: taskId,
      failureSignature: 'verify:test/unclassified',
    })

    await publish(pub, client, 'task.failed', { taskId, error: 'test suite failed' })
    await rep.drainActionQueueRepopulations(client)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    expect(row!.title).toBe('A verification check did not pass [task T-verify]')
    // A technical id is still reachable off the payload rather than the
    // operator-facing copy. Note it is the SYNTHESISED `<failingStep>/unknown`
    // from unknownFailureKind, not the original unregistered signature.
    expect(row!.payload['failureReasonCode']).toBe('verify:test/unknown')
  })

  // ── Purge-drop orphan guard ───────────────────────────────────────────────

  it('does not raise a row for task.dropped{dropReason:purged} even when task row still exists', async () => {
    // Core fix: dropTask publishes task.dropped{purged} BEFORE deleting the
    // task row. The old code checked `if (task === null) return`, which only
    // catches the delete-before-drain case. When drain is fast and the task
    // row still exists, a raise would create an orphaned row that the
    // Invalidator (which drains on the same event) will never revisit.
    // Fix: purge-drops are treated as evict-only — no raise, ever.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-purge-no-raise'

    await rep.ensureActionQueueRepopulator(client)
    // Task row still exists (as it would when dropTask publishes the event).
    await insertTaskRow(client, { id: taskId })

    await publish(pub, client, 'task.dropped', { taskId, dropReason: 'purged' })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1) // event consumed; cursor advances

    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('leaves no open row when Invalidator closes rows first, then repopulator drains task.dropped{purged} (reversed drain order)', async () => {
    // Regression: the race that caused orphan rows in production.
    // Timeline (before fix):
    //   1. dropTask emits task.dropped{purged} + task.terminal{purged}
    //   2. Invalidator drains both events → closes all open rows for task
    //   3. Repopulator drains task.dropped{purged} — task row still exists
    //   4. getTask() returns non-null → raiseActionQueueItem called → orphan row!
    //      (Invalidator won't revisit; cursor already past both events.)
    // After fix: step 3 evicts (supersedes) rather than raises → no orphan.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-reversed-drain-orphan'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, { id: taskId })

    // Step 1: a prior failure had already raised a row for this task.
    await actionQueue.raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: GENERIC_FAILURE_LABEL,
      body: 'test body',
      payload: { taskId },
      context: {},
      raisedBy: 'test',
      signature: taskId,
      originTaskId: taskId,
    })
    const openBefore = await actionQueue.listActionQueueItems('open')
    expect(openBefore.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(1)

    // Step 2: simulate the Invalidator running first — it supersedes all open
    // rows keyed to this origin (as resolveAllRowsForTask / supersedeActionQueueItemsForOrigin
    // does on task.dropped).
    await actionQueue.supersedeActionQueueItemsForOrigin(taskId, 'origin-purged', 'test-invalidator')

    const openAfterInvalidator = await actionQueue.listActionQueueItems('open')
    expect(openAfterInvalidator.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)

    // Step 3: repopulator drains task.dropped{purged} — task row still exists,
    // which is the exact condition that triggered the orphan bug before the fix.
    await publish(pub, client, 'task.dropped', { taskId, dropReason: 'purged' })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    // No new open row — the purge-drop guard evicts rather than raises.
    const openAfterRepopulator = await actionQueue.listActionQueueItems('open')
    expect(openAfterRepopulator.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('still raises a row for task.dropped with non-purge dropReason (user-skipped drops need attention)', async () => {
    // Regression guard: ensure the purge-drop guard does NOT suppress
    // task.dropped events for other drop reasons (e.g. 'user skipped').
    // Those drops are operator-driven and do warrant an action-queue row.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-user-skipped-still-raises'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, { id: taskId })

    await publish(pub, client, 'task.dropped', { taskId, dropReason: 'user skipped' })
    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    expect(openItems.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(1)
  })

  it('closes an already-open failed-task row when repopulator processes task.dropped{dropReason:purged} (post-hoc purge)', async () => {
    // Regression for: a failed-task row is raised by task.failed, then the
    // task is purged later.  When task.dropped{purged} drains through the
    // repopulator the still-open row must be closed immediately — without
    // waiting for the periodic reconcile sweep.
    //
    // Timeline:
    //   1. task.failed → repopulator raises an open row for T
    //   2. operator purges T → task.dropped{purged} published (task row still
    //      exists at event publish time, matches real dropTask ordering)
    //   3. repopulator drains task.dropped{purged} → must close the open row
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-posthoc-purge-closes-row'

    await rep.ensureActionQueueRepopulator(client)
    // Task row exists so getTask() returns non-null during task.failed drain.
    await insertTaskRow(client, { id: taskId })

    // Step 1: task.failed → open row raised
    await publish(pub, client, 'task.failed', { taskId, error: 'boom' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)

    const openBefore = await actionQueue.listActionQueueItems('open')
    expect(openBefore.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(1)

    // Step 2: task is purged — task row still exists when event is published
    // (matching real dropTask behaviour: event published before row deleted).
    await publish(pub, client, 'task.dropped', { taskId, dropReason: 'purged' })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    // Step 3: row must be closed — no manual reconcile call needed.
    const openAfter = await actionQueue.listActionQueueItems('open')
    expect(openAfter.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('supersedes the open row via task.completed for a sliced task whose origin_id differs from its own id (fingerprint asymmetry fix)', async () => {
    // Regression: when a task has origin_id = prdId (arc root differs from task id),
    // raiseActionQueueItem stores fingerprint = sha1('origin:prdId') and
    // origin_task_id = prdId. But supersedeActionQueueItemsForOrigin was called with
    // the raw task id and computed sha1('origin:taskId') — a different hash — so the
    // open row was never found and stayed open forever.
    // This test MUST FAIL against the unfixed code and PASS after the fix.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const prdId = 'prd-arc-root-001'
    const taskId = 'T-sliced-from-prd-001'

    await rep.ensureActionQueueRepopulator(client)

    // Insert a task with origin_id pointing to a PRD (arc root ≠ task id).
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (
              id, prompt, status, origin_id, retry_count,
              failure_reason, failure_reason_code,
              kind, recovery_payload,
              failure_signature, error,
              created_at, updated_at
            ) VALUES (?, ?, 'failed', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [taskId, '(test prompt)', prdId, null, null, 'task', null, null, null, now, now],
    })

    // task.failed → raiseActionQueueItem resolves taskId → prdId and stores
    // fingerprint = sha1('origin:prdId'), origin_task_id = prdId.
    await publish(pub, client, 'task.failed', { taskId, error: 'lockfile mismatch' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)

    const openAfterFailed = await actionQueue.listActionQueueItems('open')
    expect(openAfterFailed.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(1)

    // task.completed → repopulator calls supersedeActionQueueItemsForOrigin(taskId).
    // BEFORE FIX: computes sha1('origin:taskId') ≠ stored sha1('origin:prdId') → no match → row stays open.
    // AFTER FIX:  resolves taskId → prdId, computes sha1('origin:prdId') → finds row → closes it.
    await publish(pub, client, 'task.completed', { taskId, result: { status: 'done' } })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    const openAfterCompleted = await actionQueue.listActionQueueItems('open')
    expect(openAfterCompleted.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  it('supersedes the open row via task.blocked for a sliced task (fingerprint asymmetry fix)', async () => {
    // Same fingerprint asymmetry scenario but triggered by task.blocked (fix-task spawned).
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()

    const prdId = 'prd-arc-root-002'
    const taskId = 'T-sliced-from-prd-002'

    await rep.ensureActionQueueRepopulator(client)

    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (
              id, prompt, status, origin_id, retry_count,
              failure_reason, failure_reason_code,
              kind, recovery_payload,
              failure_signature, error,
              created_at, updated_at
            ) VALUES (?, ?, 'failed', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [taskId, '(test prompt)', prdId, null, null, 'task', null, null, null, now, now],
    })

    // Phase 1: task.failed → one open row (fingerprint keyed to prdId arc root)
    await publish(pub, client, 'task.failed', { taskId, error: 'install failed' })
    const { processed: p1 } = await rep.drainActionQueueRepopulations(client)
    expect(p1).toBe(1)
    expect(
      (await actionQueue.listActionQueueItems('open')).filter((i) => i.payload['taskId'] === taskId),
    ).toHaveLength(1)

    // Phase 2: task.blocked → stale row must be superseded.
    await publish(pub, client, 'task.blocked', {
      taskId,
      fixTaskId: 'fix-task-prd-002',
      failureSignature: 'setup:install/install-frozen-lockfile',
      failingStep: 'setup',
    })
    const { processed: p2 } = await rep.drainActionQueueRepopulations(client)
    expect(p2).toBe(1)

    const openAfterBlocked = await actionQueue.listActionQueueItems('open')
    expect(openAfterBlocked.filter((i) => i.payload['taskId'] === taskId)).toHaveLength(0)
  })

  // ── event-payload signature tests ────────────────────────────────────────────
  // The repopulator must read failureSignature from the task.failed event payload
  // rather than the task row, because the recovery-spawner's reopenTerminalTask
  // NULLs the task-row field before the repopulator drains the same event.
  // These tests prove both branches: a known signature names itself; a genuinely
  // absent signature still produces the "could not determine" copy.
  // The storm breaker (recovery-spawner) records the same signature value —
  // the one written by updateTask at failure time and carried in the event.

  it('uses event-payload failureSignature when task-row field was nulled by reopenTerminalTask', async () => {
    // This is the root-cause scenario: coreContinueTask fails with a known
    // signature, the recovery-spawner reopens the task (NULLing failure_signature),
    // and then the repopulator drains the task.failed event. Without the fix the
    // repopulator reads null from the task row and emits "Mars could not determine";
    // with the fix it reads the signature from the event payload.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-continue-conflict-race'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, { id: taskId })

    // Publish with a known failure signature (as updateTask does at failure time).
    await publish(pub, client, 'task.failed', {
      taskId,
      error: 'merging main into task/T-continue-conflict-race conflicted',
      failureSignature: 'continue:base-refresh-conflict/merge-conflict-unresolved',
    })

    // Simulate reopenTerminalTask NULLing the failure_signature column (as the
    // recovery-spawner does between event emission and repopulator drain).
    await client.execute({
      sql: `UPDATE tasks SET failure_signature = NULL, error = NULL WHERE id = ?`,
      args: [taskId],
    })

    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    // Title must name the signature — never the "could not determine" copy.
    expect(row!.title).toContain('continue:base-refresh-conflict/merge-conflict-unresolved')
    expect(row!.title).not.toContain('Mars could not determine why this task failed')
    // The resolved signature in the payload matches the event payload (same field
    // as the storm-breaker records).
    expect(row!.payload['failureSignature']).toBe(
      'continue:base-refresh-conflict/merge-conflict-unresolved',
    )
  })

  it('continue:base-refresh-conflict names the conflicted files via the payload capturedError', async () => {
    // The event's error field contains the full conflict summary including the
    // specific conflicted file paths. The repopulator must surface them in the
    // payload so operators can read the files from the action-queue item even
    // after the task row's error column was NULLed by reopenTerminalTask.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-continue-conflict-files'
    const conflictedFile = 'orchestrator/src/core/lib/chat-store.ts'
    const conflictSummary =
      `Cannot continue task ${taskId}: merging main into task/${taskId} conflicted.\n\n` +
      `Conflicting files:\n  - ${conflictedFile}\n\nTo resolve manually: ...`

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, { id: taskId })

    await publish(pub, client, 'task.failed', {
      taskId,
      error: conflictSummary,
      failureSignature: 'continue:base-refresh-conflict/merge-conflict-unresolved',
    })

    // Simulate reopenTerminalTask NULLing the fields.
    await client.execute({
      sql: `UPDATE tasks SET failure_signature = NULL, error = NULL WHERE id = ?`,
      args: [taskId],
    })

    await rep.drainActionQueueRepopulations(client)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    // The payload capturedError carries the error from the event, including
    // the specific conflicted file paths.
    expect(String(row!.payload['capturedError'] ?? '')).toContain(conflictedFile)
  })

  it('still emits the could-not-determine copy when neither event nor task carries a signature', async () => {
    // Genuine unknown: no failureSignature in the event payload and none in the
    // task row. The "could not determine" copy is the correct last resort here.
    const { q, actionQueue, rep, pub } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const taskId = 'T-truly-unknown'

    await rep.ensureActionQueueRepopulator(client)
    await insertTaskRow(client, { id: taskId })

    // Publish without failureSignature (truly unknown failure).
    await publish(pub, client, 'task.failed', { taskId, error: '' })

    const { processed } = await rep.drainActionQueueRepopulations(client)
    expect(processed).toBe(1)

    const openItems = await actionQueue.listActionQueueItems('open')
    const row = openItems.find((i) => i.payload['taskId'] === taskId)
    expect(row).toBeDefined()
    expect(row!.title).toContain('Mars could not determine why this task failed')
  })
})
