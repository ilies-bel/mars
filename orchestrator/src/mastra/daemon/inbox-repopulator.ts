import type { Client } from '@libsql/client'
import type { BusEvent, EventName } from '../../bus/events.js'
import {
  advanceCursor,
  fetchPending,
  registerSubscriber,
} from '../../bus/subscribers.js'
import {
  ensureProcessedOnceSchema,
  processedOnce,
} from '../../bus/processed-once.js'
import {
  raiseInboxItem,
  supersedeInboxItemsForOrigin,
  type SupersedeReason,
} from '../lib/inbox'

/**
 * Durable outbox subscriber that keeps inbox_items current from outbox
 * events — the evict-on-mutation / repopulate-on-event rule.
 *
 * Handles:
 * - task.failed / task.dropped → ensure one open origin row (fallback if
 *   no richer row already exists — raiseInboxItem's origin-keyed dedup
 *   makes this naturally idempotent).
 * - task.queued / task.completed / task.unblocked → evict open origin rows
 *   so they disappear once the task leaves the stuck state.
 * - proposal.added → insert a draft-proposal inbox row keyed on proposal id.
 * - proposal.promoted / proposal.dismissed / proposal.deleted → evict the
 *   proposal's draft-proposal row.
 * - task.blocked → NO action (blocked tasks do not create inbox rows).
 * - Stale-worktree rows are produced by the existing daemon sweep and
 *   evicted by dismissAlertsOnStatusChange in queue.ts; this consumer
 *   does not create them and does not fight them.
 *
 * Each side effect is guarded by processedOnce for at-most-once application:
 * processedOnce atomically commits a dedup row in queue.db, then the actual
 * inbox mutations run on state.db AFTER that transaction commits. The two
 * writes are not cross-DB atomic, but inbox operations are idempotent, so
 * the rare crash between dedup-commit and inbox-write is benign (at-most-once
 * is preserved; the inbox write is simply skipped on restart).
 */
export const INBOX_REPOPULATOR_SUBSCRIBER = 'inbox-repopulator'

/** Events that ensure exactly one open origin row exists for the task. */
const TASK_RAISE_EVENTS = new Set<EventName>(['task.failed', 'task.dropped'])

/**
 * Events that evict open origin rows because the task left the stuck state.
 * Maps event type to the SupersedeReason recorded on the resolution.
 */
const TASK_EVICT_REASONS: Partial<Record<EventName, SupersedeReason>> = {
  'task.queued': 'status-changed',
  'task.completed': 'origin-done',
  'task.unblocked': 'status-changed',
}

/**
 * Proposal terminal events that evict the proposal's draft-proposal row.
 * Maps event type to the SupersedeReason recorded on the resolution.
 */
const PROPOSAL_EVICT_REASONS: Partial<Record<EventName, SupersedeReason>> = {
  'proposal.promoted': 'origin-done',
  'proposal.dismissed': 'origin-dropped',
  'proposal.deleted': 'origin-purged',
}

/**
 * Register the inbox-repopulator subscriber. `replay: false` so it starts
 * at the current outbox head and only reacts to future events — historical
 * inbox state is already reconciled by existing chokepoints. Idempotent.
 *
 * Also ensures the processedOnce dedup schema exists so that
 * {@link drainInboxRepopulations} can safely call processedOnce.
 */
export async function ensureInboxRepopulator(client: Client): Promise<void> {
  await ensureProcessedOnceSchema(client)
  await registerSubscriber(client, INBOX_REPOPULATOR_SUBSCRIBER, {
    replay: false,
  })
}

/**
 * Apply the inbox mutation for a single mapped event.
 *
 * Separated from the drain loop so the caller can invoke it AFTER the
 * processedOnce transaction commits — this avoids holding a write
 * transaction on queue.db while also writing to state.db (which may be
 * the same file in some configurations, causing SQLITE_BUSY).
 */
async function applyInboxMutation(event: BusEvent): Promise<void> {
  if (TASK_RAISE_EVENTS.has(event.type)) {
    const { taskId } = event.payload as { taskId: string }
    // raiseInboxItem is idempotent: if an open origin row already exists
    // (raised by a richer writer such as queue-fix-tasks), it bumps
    // seen_count rather than inserting a duplicate row.
    await raiseInboxItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      title: `Task ${taskId} needs attention`,
      body: [
        `Task \`${taskId}\` reached \`${event.type}\` without a specific recovery plan.`,
        '',
        `Inspect the full log with \`mars log ${taskId}\`.`,
      ].join('\n'),
      payload: { taskId, eventType: event.type },
      context: {},
      raisedBy: `inbox-repopulator:${event.type}`,
      signature: taskId,
      originTaskId: taskId,
    })
  } else if (event.type in TASK_EVICT_REASONS) {
    const reason = TASK_EVICT_REASONS[event.type]!
    const { taskId } = event.payload as { taskId: string }
    await supersedeInboxItemsForOrigin(
      taskId,
      reason,
      `inbox-repopulator:${event.type}`,
    )
  } else if (event.type === 'proposal.added') {
    const payload = event.payload as {
      proposalId: string
      source: string
      title: string
    }
    await raiseInboxItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: `Draft proposal: ${payload.title}`,
      body: [
        `Proposal \`${payload.proposalId}\` from \`${payload.source}\` is ready for review.`,
        '',
        `Run \`mars proposal show ${payload.proposalId}\` to see details.`,
      ].join('\n'),
      payload: {
        proposalId: payload.proposalId,
        source: payload.source,
      },
      context: {},
      raisedBy: 'inbox-repopulator:proposal.added',
      signature: payload.proposalId,
      originTaskId: payload.proposalId,
    })
  } else {
    // PROPOSAL_EVICT_REASONS: proposal.promoted / proposal.dismissed / proposal.deleted
    const reason = PROPOSAL_EVICT_REASONS[event.type]!
    const { proposalId } = event.payload as { proposalId: string }
    await supersedeInboxItemsForOrigin(
      proposalId,
      reason,
      `inbox-repopulator:${event.type}`,
    )
  }
}

/**
 * Process every event the subscriber has not yet acknowledged, in order.
 *
 * For each handled event type, processedOnce atomically commits a dedup
 * row in queue.db; then the inbox mutation runs on state.db after that
 * transaction commits. This two-phase approach avoids holding a write lock
 * on the shared DB file while also mutating the inbox tables.
 *
 * Unmapped events (including task.blocked) are skipped (no inbox work) but
 * still advance the cursor so the subscriber never stalls.
 *
 * On a processing error the cursor is NOT advanced and the drain breaks, so
 * the failed event is retried on the next pass rather than being silently
 * dropped.
 *
 * @param client The libsql client carrying the outbox tables (queue.db).
 * @param log    Optional logger callback for per-event failures.
 * @returns      The count of events for which inbox work was applied.
 */
export async function drainInboxRepopulations(
  client: Client,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  const pending = await fetchPending(client, INBOX_REPOPULATOR_SUBSCRIBER)
  let processed = 0

  for (const event of pending) {
    const isMapped =
      TASK_RAISE_EVENTS.has(event.type) ||
      event.type in TASK_EVICT_REASONS ||
      event.type === 'proposal.added' ||
      event.type in PROPOSAL_EVICT_REASONS

    if (isMapped) {
      try {
        // Phase 1: Atomically claim the at-most-once dedup slot in queue.db.
        // The sideEffect is intentionally empty: running inbox mutations inside
        // the write transaction would cause SQLITE_BUSY if queue.db and state.db
        // share the same file (as they do in some test configurations). Instead,
        // the actual inbox writes happen in Phase 2, after the transaction commits.
        const { ran } = await processedOnce({
          client,
          subscriberId: INBOX_REPOPULATOR_SUBSCRIBER,
          eventId: event.id,
          sideEffect: async (_tx) => {},
        })

        if (ran) {
          // Phase 2: Apply the inbox mutation now that the dedup row is committed.
          // processedOnce guarantees this branch runs at most once per (subscriber,
          // event) — concurrent drain calls cannot double-apply.
          await applyInboxMutation(event)
          processed++
        }
      } catch (err) {
        log?.(
          `[inbox-repopulator] event ${event.id} (${event.type}) failed: ${(err as Error).message}`,
        )
        // Do NOT advance the cursor for this event — break so the next
        // drain retries from here rather than skipping past the failure.
        break
      }
    }

    // Reached for both mapped (success) and unmapped events.
    // A throw in the mapped branch breaks above, before this line.
    await advanceCursor(client, INBOX_REPOPULATOR_SUBSCRIBER, event.id)
  }

  return { processed }
}
