import type { DbClient } from '../lib/db.js'
import type { BusEvent, EventName } from '../../bus/events.js'
import { registerSubscriber } from '../../bus/subscribers.js'
import { drainWithStall } from './subscriber-drain.js'
import { resolveFailureKind, failedTaskTitle } from '../lib/failure-kinds'
import {
  raiseActionQueueItem,
  resolveAllRowsForTask,
  supersedeActionQueueItemsForOrigin,
  type SupersedeReason,
} from '../lib/action-queue'
import { getTask } from '../queue'
import { registerSubscriberName } from '../../outbox/registry.js'

/**
 * Durable outbox subscriber that keeps action_queue_items current from outbox
 * events — the evict-on-mutation / repopulate-on-event rule.
 *
 * Handles:
 * - task.failed / task.dropped → ensure one open origin row (fallback if
 *   no richer row already exists — raiseActionQueueItem's origin-keyed dedup
 *   makes this naturally idempotent).
 * - task.queued / task.completed / task.unblocked → evict open origin rows
 *   so they disappear once the task leaves the stuck state.
 * - proposal.added → insert a draft-proposal actionQueue row keyed on proposal id.
 * - proposal.promoted / proposal.sliced / proposal.dismissed / proposal.deleted
 *   → evict proposal-keyed action rows.
 * - scorer.suggested → insert a scorer-suggested actionQueue row keyed on
 *   scorer id (pure projection of scorers.status='suggested', ADR-0048).
 * - scorer.accepted / scorer.dismissed → evict the scorer's row.
 * - task.blocked → NO action (blocked tasks do not create actionQueue rows).
 * - Stale-worktree rows are produced by the existing daemon sweep and
 *   evicted by dismissAlertsOnStatusChange in queue.ts; this consumer
 *   does not create them and does not fight them.
 *
 * Each side effect is guarded by processedOnce for at-most-once application:
 * processedOnce atomically commits a dedup row in mars.db, then the actual
 * actionQueue mutations run after that transaction commits. The actionQueue
 * operations are idempotent, so the rare crash between dedup-commit and
 * actionQueue-write is benign (at-most-once is preserved; the actionQueue
 * write is simply skipped on restart).
 */
export const ACTION_QUEUE_REPOPULATOR_SUBSCRIBER = 'action-queue-repopulator'
registerSubscriberName(ACTION_QUEUE_REPOPULATOR_SUBSCRIBER)

/** Events that ensure exactly one open origin row exists for the task. */
const TASK_RAISE_EVENTS = new Set<EventName>(['task.failed', 'task.dropped'])

/**
 * Events that evict open origin rows because the task left the stuck state.
 * Maps event type to the SupersedeReason recorded on the resolution.
 *
 * NOTE: `task.blocked` is intentionally included here. A task may have a
 * previously-raised `failed` row from before the fix-task was spawned. When
 * the task transitions to `blocked` (a fix task is now working on it), that
 * stale row must be superseded so it does not appear in the action queue as a
 * spurious "needs attention" card while the fix task runs.
 */
const TASK_EVICT_REASONS: Partial<Record<EventName, SupersedeReason>> = {
  'task.queued': 'status-changed',
  'task.completed': 'origin-done',
  'task.unblocked': 'status-changed',
  'task.blocked': 'status-changed',
}

/**
 * Proposal terminal events that evict the proposal's draft-proposal row.
 * Maps event type to the SupersedeReason recorded on the resolution.
 */
const PROPOSAL_EVICT_REASONS: Partial<Record<EventName, SupersedeReason>> = {
  'proposal.promoted': 'origin-done',
  'proposal.sliced': 'origin-done',
  'proposal.dismissed': 'origin-dropped',
  'proposal.deleted': 'origin-purged',
}

/**
 * Scorer triage events that evict the scorer's 'scorer-suggested' row.
 * Pure projection (ADR-0048): the row exists iff the scorers row is in
 * status='suggested'; accept/dismiss are the only exits.
 */
const SCORER_EVICT_REASONS: Partial<Record<EventName, SupersedeReason>> = {
  'scorer.accepted': 'origin-done',
  'scorer.dismissed': 'origin-dropped',
}

/**
 * Register the action-queue-repopulator subscriber. `replay: false` so it starts
 * at the current outbox head and only reacts to future events — historical
 * actionQueue state is already reconciled by existing chokepoints. Idempotent.
 * (The processedOnce dedup table is part of the canonical schema, guaranteed
 * by ensureSchema at daemon boot.)
 */
export async function ensureActionQueueRepopulator(client: DbClient): Promise<void> {
  await registerSubscriber(client, ACTION_QUEUE_REPOPULATOR_SUBSCRIBER, {
    replay: false,
  })
}

/**
 * Apply the actionQueue mutation for a single mapped event.
 *
 * Separated from the drain loop so the caller can invoke it AFTER the
 * processedOnce transaction commits — the dedup claim and the actionQueue
 * mutation stay in separate transactions, so a crash between them replays a
 * benign no-op instead of double-applying (see drainWithStall).
 */
async function applyActionQueueMutation(event: BusEvent): Promise<void> {
  if (TASK_RAISE_EVENTS.has(event.type)) {
    const { taskId } = event.payload as { taskId: string; dropReason?: string }

    // Purge-drop guard: dropTask emits task.dropped{dropReason:'purged'} +
    // task.terminal{purged} before deleting the task row. The Invalidator
    // (alert-dismisser) closes all open rows when it drains task.dropped.
    // If the Invalidator drains task.dropped and task.terminal BEFORE this
    // subscriber processes task.dropped, a raise here would create an orphaned
    // action-queue row that the Invalidator will never revisit (its cursor has
    // already passed those events). Fix: treat purge-drops as an evict-only
    // operation — supersede any still-open rows and return without raising.
    // Idempotent: if the Invalidator already closed the rows, supersede is a
    // silent no-op.
    if (event.type === 'task.dropped') {
      const { dropReason } = event.payload as { taskId: string; dropReason: string }
      if (dropReason === 'purged') {
        // Belt-and-suspenders close: resolveAllRowsForTask catches rows keyed
        // by origin_task_id directly (covers any row that was raised for this
        // task, regardless of fingerprint). supersedeActionQueueItemsForOrigin
        // then handles rows matched by fingerprint with proper history/events.
        // Both are idempotent — rows already closed by the other call are a
        // silent no-op. Together they ensure a post-hoc purge (task purged
        // after the failed-task row was already raised) closes the stale row
        // immediately without waiting for the next reconcile sweep.
        await resolveAllRowsForTask(taskId)
        await supersedeActionQueueItemsForOrigin(
          taskId,
          'origin-purged',
          `action-queue-repopulator:${event.type}`,
        )
        return
      }
    }

    // Load the task to check its kind and read its structured failure signature.
    const task = await getTask(taskId)

    // Race guard (purge-before-drain): only dropTask deletes task rows, so
    // task === null means the task was purged before this subscriber turn ran.
    // Raising a row for a deleted task creates an orphaned action-queue item
    // that can never be closed — the Invalidator already ran its close pass
    // for this task (driven by task.terminal{purged}) before this repopulator
    // drained, and its cursor will not revisit that close event. Skip.
    if (task === null) return

    // Fix-task override: any failed recovery task (kind='fix') is already owned
    // by the origin-keyed escalation row raised in handleTaskFailureWithFixTask
    // (queue-fix-tasks.ts). The repopulator must not raise a second row for any
    // fix task — doing so would split one arc into two alert entries in the
    // action queue. The origin-keyed row is the single owner regardless of recipe.
    if (task.kind === 'fix') return

    // Resolve the single Failure kind record from the structured failure
    // signature (ADR-0042). This keys on the `<failingStep>/<error-class>`
    // signature written at failure time — NOT a re-grep of the raw failure
    // string — so a failure whose step and cause are known resolves to its
    // real record (title, reason, recipe ref, action menu) instead of
    // collapsing to `unknown`. Falls through to an unknown record when the
    // signature is null or unregistered.
    const sig = task.failureSignature ?? null
    const fk = resolveFailureKind(sig, task.error ?? '')

    // raiseActionQueueItem is idempotent: if an open origin row already exists,
    // it bumps seen_count rather than inserting a duplicate row.
    await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'high',
      // The persisted title carries the same discriminators the derived view
      // renders (signature + short task id), so an operator reading the raw
      // row and one reading `mars action-queue list` see the same thing.
      title: failedTaskTitle({
        signature: sig,
        taskId,
        capturedError: task.error ?? '',
      }),
      body: fk.verboseReason,
      payload: {
        taskId,
        eventType: event.type,
        failureSignature: fk.signature,
        failureReasonCode: fk.signature,
        availableActions: fk.actions.map((a) => ({
          id: a.id,
          label: a.label,
          op: a.op,
        })),
      },
      context: {},
      raisedBy: `action-queue-repopulator:${event.type}`,
      signature: taskId,
      originTaskId: taskId,
    })
  } else if (event.type in TASK_EVICT_REASONS) {
    const reason = TASK_EVICT_REASONS[event.type]!
    const { taskId } = event.payload as { taskId: string }
    await supersedeActionQueueItemsForOrigin(
      taskId,
      reason,
      `action-queue-repopulator:${event.type}`,
    )
  } else if (event.type === 'proposal.added') {
    const payload = event.payload as {
      proposalId: string
      source: string
      title: string
    }
    await raiseActionQueueItem({
      kind: 'draft-proposal',
      category: 'user',
      priority: 'normal',
      title: `Draft proposal: ${payload.title}`,
      body: `Proposal \`${payload.proposalId}\` from \`${payload.source}\` is ready for review.`,
      payload: {
        proposalId: payload.proposalId,
        source: payload.source,
      },
      context: {},
      raisedBy: 'action-queue-repopulator:proposal.added',
      signature: payload.proposalId,
      originTaskId: payload.proposalId,
    })
  } else if (event.type === 'scorer.suggested') {
    // Per-arc reflection landed a suggested Scorer — project it into a
    // 'scorer-suggested' row keyed on the scorer id. raiseActionQueueItem's
    // origin-keyed dedup keeps re-drains idempotent; the entity-side
    // fingerprint dedup in scorers.ts prevents a second `scorer.suggested`
    // event for the same (workflow, dimension) while one sits suggested.
    const payload = event.payload as {
      scorerId: string
      workflow: string
      title: string
    }
    await raiseActionQueueItem({
      kind: 'scorer-suggested',
      category: 'reflector',
      priority: 'normal',
      title: `Suggested Scorer: ${payload.title} (workflow: ${payload.workflow})`,
      body:
        `Per-arc reflection found a measurement gap on the '${payload.workflow}' workflow and suggested a Scorer grading '${payload.title}'.\n` +
        `Review with \`mars scorer show ${payload.scorerId}\`, then \`mars scorer accept ${payload.scorerId}\` or \`mars scorer dismiss ${payload.scorerId}\`.`,
      payload: {
        scorerId: payload.scorerId,
        workflow: payload.workflow,
      },
      context: {},
      raisedBy: 'action-queue-repopulator:scorer.suggested',
      signature: payload.scorerId,
      originTaskId: payload.scorerId,
    })
  } else if (event.type in SCORER_EVICT_REASONS) {
    // scorer.accepted / scorer.dismissed — the entity left 'suggested', so
    // the pure projection closes (ADR-0048).
    const reason = SCORER_EVICT_REASONS[event.type]!
    const { scorerId } = event.payload as { scorerId: string }
    await supersedeActionQueueItemsForOrigin(
      scorerId,
      reason,
      `action-queue-repopulator:${event.type}`,
    )
  } else {
    // PROPOSAL_EVICT_REASONS: proposal.promoted / proposal.sliced /
    // proposal.dismissed / proposal.deleted
    const reason = PROPOSAL_EVICT_REASONS[event.type]!
    const { proposalId } = event.payload as { proposalId: string }
    await supersedeActionQueueItemsForOrigin(
      proposalId,
      reason,
      `action-queue-repopulator:${event.type}`,
    )
  }
}

/**
 * Scan `tool_promotion_attempts` for rows in status='benchmarked' and raise
 * one action-queue item per attempt.
 *
 * Idempotent: `raiseActionQueueItem` uses the attempt id as the dedup
 * signature, so re-scanning an already-raised attempt bumps `seen_count`
 * rather than inserting a duplicate row.
 *
 * @returns Count of attempts for which a raise was attempted.
 */
export async function drainToolPromotionLedger(
  client: DbClient,
): Promise<{ raised: number }> {
  const result = await client.execute(
    `SELECT id, helper_key, benchmark_before, benchmark_after, motivating_arc_ids
       FROM tool_promotion_attempts
      WHERE status = 'benchmarked'`,
  )

  let raised = 0
  for (const row of result.rows) {
    const attemptId = row['id'] as string
    const helperKey = row['helper_key'] as string
    const before: unknown = row['benchmark_before']
      ? JSON.parse(row['benchmark_before'] as string)
      : null
    const after: unknown = row['benchmark_after']
      ? JSON.parse(row['benchmark_after'] as string)
      : null
    const motivatingArcIds: string[] = row['motivating_arc_ids']
      ? JSON.parse(row['motivating_arc_ids'] as string)
      : []

    await raiseActionQueueItem({
      kind: 'tool-promotion',
      category: 'reflector',
      priority: 'normal',
      title: `Helper ready for promotion: ${helperKey}`,
      body:
        `Benchmark evidence is available for helper \`${helperKey}\`.\n` +
        `Review the before/after stats and approve or reject via ` +
        `\`mars tool promote ${attemptId}\` or \`mars tool reject ${attemptId}\`.`,
      payload: {
        attemptId,
        helperKey,
        before,
        after,
        motivatingArcIds,
      },
      context: {},
      raisedBy: 'action-queue-repopulator:tool-promotion-scan',
      signature: `tool-promotion:${attemptId}`,
      originTaskId: attemptId,
    })
    raised++
  }

  return { raised }
}

/**
 * Process every event the subscriber has not yet acknowledged, in order.
 *
 * For each handled event type, processedOnce atomically commits a dedup
 * row; then the actionQueue mutation runs after that transaction commits.
 * The two-phase shape keeps the crash window benign: a replay after a crash
 * between the phases re-runs an idempotent mutation.
 *
 * Unmapped events (including task.blocked) are skipped (no actionQueue work) but
 * still advance the cursor so the subscriber never stalls.
 *
 * On a processing error the cursor is NOT advanced and the drain breaks, so
 * the failed event is retried on the next pass rather than being silently
 * dropped.
 *
 * @param client The DB client carrying the outbox tables.
 * @param log    Optional logger callback for per-event failures.
 * @returns      The count of events for which actionQueue work was applied.
 */
export async function drainActionQueueRepopulations(
  client: DbClient,
  log?: (msg: string) => void,
): Promise<{ processed: number }> {
  // Stall contract (ADR-0032) is shared with the Invalidator via
  // drainWithStall: a thrown handler blocks this subscriber's cursor and
  // raises a subscriber-stalled actionQueue row after K failures. The actionQueue
  // mutation is idempotent and runs after the dedup commit (Phase 2), so the
  // cross-DB crash window stays benign.
  return drainWithStall({
    client,
    subscriberId: ACTION_QUEUE_REPOPULATOR_SUBSCRIBER,
    log,
    handle: async (event) => {
      const isMapped =
        TASK_RAISE_EVENTS.has(event.type) ||
        event.type in TASK_EVICT_REASONS ||
        event.type === 'proposal.added' ||
        event.type in PROPOSAL_EVICT_REASONS ||
        event.type === 'scorer.suggested' ||
        event.type in SCORER_EVICT_REASONS
      if (!isMapped) return false
      await applyActionQueueMutation(event)
      return true
    },
  })
}
