import type { DbClient } from '../../core/lib/db.js';
import { processedOnce } from '../../bus/processed-once.js';
import type { Subscriber } from '../dispatcher.js';
import type { BusEvent } from '../../bus/events.js';
import { raiseActionQueueItem, setActionQueueState, supersedeActionQueueItemsForOrigin } from '../../core/lib/action-queue.js';
import { apiCircuitBreaker } from '../../core/lib/api-circuit-breaker.js';
import { resolveStateClient } from '../../core/store/state-client.js';
import { registerSubscriberName } from '../registry.js';

/** Unique name for the durable action-queue-raiser:task.blocked subscriber. */
export const ACTION_QUEUE_RAISER_SUBSCRIBER = 'action-queue-raiser:task.blocked';
registerSubscriberName(ACTION_QUEUE_RAISER_SUBSCRIBER);

/** Unique name for the durable subscriber that resolves stale 'failed' rows when a fix task completes. */
export const FIX_TASK_DONE_RESOLVER_SUBSCRIBER = 'action-queue-raiser:fix-task-done';
registerSubscriberName(FIX_TASK_DONE_RESOLVER_SUBSCRIBER);

/**
 * Unique name for the durable subscriber that closes open action-queue rows
 * when a task is dropped via the supersede path (ADR-0048 entity status is
 * the sole mechanism to clear a row). Only fires when `dropReason` signals a
 * supersede — other dropped transitions (e.g. from `dropTask`) leave rows
 * untouched.
 */
export const DROPPED_VIA_SUPERSEDE_CLEARER_SUBSCRIBER = 'action-queue-raiser:task.dropped-via-supersede';
registerSubscriberName(DROPPED_VIA_SUPERSEDE_CLEARER_SUBSCRIBER);

/**
 * Fix task statuses that indicate recovery is actively in progress and no
 * human action is required. Matches the "outstanding" set described in the
 * invariant (ADR-0051): the alert surface must be clear while automated
 * recovery is running.
 */
const OUTSTANDING_FIX_TASK_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'verifying',
  'merging',
  'vega-reconciling',
  'draft',
  'blocked',
]);

/**
 * Mirror the same grace window used by recovery-spawn: treat any failure
 * that fired while the breaker was open (or within 60 s of it opening) as
 * environmental. In practice `close()` clears `openedAt`, so the second arm
 * only fires while the breaker is still open — the constant lives here to
 * make the intent explicit and keep the two check sites in sync.
 */
const GRACE_MS = 60_000

/**
 * Build the Outbox Subscribers that durably raise action-queue items
 * in reaction to state-change events.
 *
 * Each subscriber wraps its handler in {@link processedOnce} so that
 * replaying the same event id never produces additional action-queue rows. The
 * action-queue write is routed through {@link raiseActionQueueItem} so that
 * arc-key normalization, origin resolution via `resolveOriginIdForTask`, and
 * origin-fingerprint dedup all happen at the single raise path (ADR-0051).
 *
 * @param client  The shared DB client used for the per-subscriber
 *   processedOnce dedup table.
 */
export function buildActionQueueRaiserSubscribers(client: DbClient): Subscriber[] {
  return [
    taskBlockedActionQueueRaiser(client),
    fixTaskDoneActionQueueResolver(client),
    droppedViaSupersedeClearer(client),
  ];
}

/**
 * Subscriber that converts `task.blocked` outbox events into durable
 * action-queue items.
 *
 * **Environmental failures (circuit breaker open):** when `apiCircuitBreaker`
 * is tripped (or within the {@link GRACE_MS} window), the per-task `failed`
 * row is suppressed. Instead a single `api-outage` row keyed on
 * `api-outage:<openedAt>` is upserted — first occurrence inserts with
 * `seen_count=1`, subsequent ones bump `seen_count` and append the task id
 * to `payload.occurrences`. This gives the operator one row per outage
 * episode rather than one row per affected task.
 *
 * **Non-environmental failures:** one open item per arc origin
 * (origin-fingerprint dedup inside {@link raiseActionQueueItem}); a
 * subsequent `task.blocked` event for the same arc bumps `seen_count` on
 * the existing open row rather than inserting a duplicate.
 *
 * Fix/descendant tasks (where `originId` is absent from the payload but the
 * task row carries an `origin_id` in the DB) are resolved to their arc root
 * internally by `raiseActionQueueItem` via `resolveOriginIdForTask`, so one
 * arc surfaces as exactly one row regardless of which slice triggered the
 * block.
 */
function taskBlockedActionQueueRaiser(client: DbClient): Subscriber {
  return {
    name: 'action-queue-raiser:task.blocked',
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'task.blocked') return;

      const p = event.payload as {
        taskId: string;
        fixTaskId: string | null;
        failureSignature: string;
        failingStep: string;
        /** Present on events from upsertFixTask / attachToExistingFixTask / spawnOrAttachMainCommitter. */
        originId?: string;
      };

      // Event-level dedup: if this (subscriberId, eventId) pair has already
      // been processed, processedOnce returns {ran:false} and we skip. This
      // prevents duplicate raises from event-replay.
      const { ran } = await processedOnce({
        client,
        subscriberId: 'action-queue-raiser:task.blocked',
        eventId: event.id,
        sideEffect: async (_tx) => {
          // Event-level dedup only. The action-queue write is routed through
          // raiseActionQueueItem below (outside this transaction) so that
          // arc-key normalization happens at the single raise path (ADR-0051).
        },
      });

      if (!ran) return;

      // Detect environmental failures using the same logic as recovery-spawn:
      // breaker open, or opened within GRACE_MS (the second arm is currently
      // unreachable because close() clears openedAt, but mirrors the intent).
      const breaker = apiCircuitBreaker.state();
      const isEnvironmental =
        breaker.open ||
        (breaker.openedAt !== null && Date.now() - breaker.openedAt < GRACE_MS);

      if (isEnvironmental && breaker.openedAt !== null) {
        // Suppress the per-task row. Upsert a single api-outage row keyed on
        // the breaker's openedAt so all failures in the same cycle coalesce.
        const openedAt = breaker.openedAt;
        await raiseActionQueueItem({
          kind: 'api-outage',
          category: 'orchestrator',
          priority: 'urgent',
          title: `API outage: ${breaker.reason ?? 'circuit breaker open'}`,
          body: `The Anthropic API circuit breaker tripped at ${new Date(openedAt).toISOString()}. Affected tasks are tracked in payload.occurrences and will be requeued when connectivity is restored.`,
          payload: {
            openedAt,
            reason: breaker.reason,
          },
          context: {},
          raisedBy: 'outbox:action-queue-raiser:task.blocked',
          signature: `api-outage:${openedAt}`,
          occurrence: {
            taskId: p.taskId,
            failureSignature: p.failureSignature,
            failingStep: p.failingStep,
          },
        });
        return;
      }

      // Non-environmental path: if a fix/recovery task is in flight (or already
      // completed successfully), automated recovery is handling the failure and
      // no human action is required. Skip the raise entirely.
      // Only raise when fixTaskId is null (no recovery task exists) or when the
      // fix task itself failed/dropped (recovery was exhausted — the separate
      // orchestrator:recovery-exhausted path in queue-retry.ts is the human-facing
      // surface for that case, but we also raise here to be conservative).
      if (p.fixTaskId !== null) {
        const fixRow = await client.execute({
          sql: `SELECT status FROM tasks WHERE id = ?`,
          args: [p.fixTaskId],
        });
        if (fixRow.rows.length > 0) {
          const fixStatus = (fixRow.rows[0] as unknown as { status: string }).status;
          const isTerminalFailure = fixStatus === 'failed' || fixStatus === 'dropped';
          if (!isTerminalFailure) {
            // Fix task is outstanding or completed successfully — no human action needed.
            return;
          }
          // Fix task failed/dropped → fall through and raise.
        }
        // Fix task not found in DB → raise (anomaly; conservative default).
      }

      // Learned-recipe auto-run: if the operator has taught a recovery op for
      // this failure signature, execute it automatically instead of raising a
      // card. On success, log and publish the auto-run so the continuous
      // conversation can narrate it and WYWA retains it historically. On error,
      // fall through and raise the card as normal so the operator can intervene.
      if (p.failureSignature) {
        const { getLearnedRecipe, executeLearnedOp, logAutoRecipeRun } =
          await import('../../core/lib/learned-recipes.js');
        const learned = await getLearnedRecipe(p.failureSignature);
        if (learned !== null) {
          try {
            await executeLearnedOp(p.taskId, learned.actionOp);
            await logAutoRecipeRun({
              signature: p.failureSignature,
              actionOp: learned.actionOp,
              taskId: p.taskId,
            });
            const { emitRecipeAutoRun } = await import('../../core/recipes/teach.js');
            await emitRecipeAutoRun(client, {
              recipeId: learned.failureSignature,
              failureKind: p.failureSignature,
              targetTaskId: p.taskId,
              at: new Date().toISOString(),
            });
            // Auto-run succeeded — do NOT raise a card.
            return;
          } catch {
            // Auto-run failed (e.g. unsupported op, wrong status): fall through
            // and raise the standard card so the operator can act manually.
          }
        }
      }

      // Slice 6: load stall_diagnostics from the task row (best-effort — null on any error).
      let stallDiagnostics: unknown | null = null
      try {
        const taskDiagRow = await client.execute({
          sql: `SELECT stall_diagnostics FROM tasks WHERE id = ?`,
          args: [p.taskId],
        })
        if (taskDiagRow.rows.length > 0) {
          const raw = (taskDiagRow.rows[0] as unknown as { stall_diagnostics: string | null }).stall_diagnostics
          if (raw) stallDiagnostics = JSON.parse(raw)
        }
      } catch {
        // Non-fatal: proceed without diagnostics.
      }

      // Slice 6: compute a live pool snapshot from task status counts.
      let poolSnapshot: {
        activeWorkerCount: number
        queuedCount: number
        runningCount: number
        blockedCount: number
        recentDispatchDecisions: string[]
      } = {
        activeWorkerCount: 0,
        queuedCount: 0,
        runningCount: 0,
        blockedCount: 0,
        recentDispatchDecisions: [],
      }
      try {
        const countRows = await client.execute(
          `SELECT status, COUNT(*) AS n FROM tasks WHERE status IN ('queued', 'running', 'blocked') GROUP BY status`,
        )
        const counts: Record<string, number> = {}
        for (const row of countRows.rows as unknown as Array<{ status: string; n: number | bigint }>) {
          counts[row.status] = Number(row.n)
        }
        const runningCount = counts['running'] ?? 0
        poolSnapshot = {
          activeWorkerCount: runningCount,
          queuedCount: counts['queued'] ?? 0,
          runningCount,
          blockedCount: counts['blocked'] ?? 0,
          recentDispatchDecisions: [],
        }
      } catch {
        // Non-fatal: keep zero-valued snapshot.
      }

      // Route through the single raise path (ADR-0051).
      // raiseActionQueueItem calls resolveOriginIdForTask(originTaskId) internally
      // so fix/descendant tasks collapse onto their arc root. We pass originTaskId
      // raw and avoid double-resolution at the call site.
      await raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Task ${p.taskId} blocked`,
        body: `Task blocked at ${p.failingStep} with failure signature ${p.failureSignature}.`,
        payload: {
          taskId: p.taskId,
          failureSignature: p.failureSignature,
          failingStep: p.failingStep,
          stallDiagnostics,
          poolSnapshot,
        },
        context: {},
        raisedBy: 'outbox:action-queue-raiser:task.blocked',
        signature: `task.blocked:${p.taskId}`,
        originTaskId: p.originId ?? p.taskId,
      });
    },
  };
}

/**
 * Subscriber that resolves stale open `kind='failed'` action-queue rows when
 * the associated fix/recovery task completes successfully.
 *
 * When a fix task finishes with `reason='done'`, any open 'failed' row for its
 * arc origin is no longer actionable — the failure was handled automatically.
 * This subscriber closes those rows so the action queue only surfaces true
 * dead-ends that require human intervention.
 *
 * Idempotent via `processedOnce`: replaying the same terminal event never
 * resolves a row a second time.
 *
 * A fix task is identified by having a non-null `origin_id` in the tasks
 * table (pointing at its arc origin). Non-fix tasks (no `origin_id`) are
 * ignored.
 */
function fixTaskDoneActionQueueResolver(client: DbClient): Subscriber {
  return {
    name: FIX_TASK_DONE_RESOLVER_SUBSCRIBER,
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'task.terminal') return;

      const p = event.payload as { taskId: string; reason: string };
      if (p.reason !== 'done') return;

      const { ran } = await processedOnce({
        client,
        subscriberId: FIX_TASK_DONE_RESOLVER_SUBSCRIBER,
        eventId: event.id,
        sideEffect: async (_tx) => {
          // Event-level dedup only; the action-queue write happens outside.
        },
      });
      if (!ran) return;

      // Check whether the completed task is a fix/recovery task (i.e. has an
      // origin_id pointing at its arc origin). Non-fix tasks have no origin_id.
      const taskRow = await client.execute({
        sql: `SELECT origin_id FROM tasks WHERE id = ?`,
        args: [p.taskId],
      });
      if (taskRow.rows.length === 0) return;

      const tr = taskRow.rows[0] as unknown as { origin_id: string | null };
      if (!tr.origin_id) return; // not a fix/recovery task

      const originId = tr.origin_id;

      // Resolve every open 'failed' row for this arc origin. In practice there
      // is at most one open row per arc (origin-fingerprint dedup), but we loop
      // to be defensive.
      const openRows = await client.execute({
        sql: `SELECT id FROM action_queue_items
               WHERE kind = 'failed' AND state = 'open' AND origin_task_id = ?`,
        args: [originId],
      });

      for (const row of openRows.rows) {
        const id = (row as unknown as { id: string }).id;
        await setActionQueueState(id, 'resolved', {
          note: `fix task ${p.taskId} completed successfully`,
          by: `outbox:${FIX_TASK_DONE_RESOLVER_SUBSCRIBER}`,
        });
      }
    },
  };
}

/**
 * Subscriber that closes open action-queue rows when a task is dropped via the
 * supersede path.
 *
 * When `Arc.createOrigin` supersedes an existing task it calls `updateTask`
 * with `{ status: 'dropped', failureReason: 'superseded by new task <id>' }`.
 * That write emits a `task.dropped` outbox event whose `dropReason` carries the
 * free-text value. This subscriber detects that string prefix and auto-resolves
 * any open action-queue row that was keyed to the superseded task, so the
 * operator does not see a stale alert for work that has been continued by the
 * rescuing task (ADR-0048 entity status is the sole mechanism to clear a row).
 *
 * Gate: only processes events where `dropReason` starts with
 * `'superseded by new task'`. All other `task.dropped` events are ignored, so
 * drops caused by `dropTask` or other paths never silently close rows.
 *
 * Idempotent via `processedOnce`: replaying the same event never closes a row
 * a second time. Already-resolved rows are also a no-op (handled inside
 * `supersedeActionQueueItemsForOrigin`).
 */
function droppedViaSupersedeClearer(client: DbClient): Subscriber {
  return {
    name: DROPPED_VIA_SUPERSEDE_CLEARER_SUBSCRIBER,
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'task.dropped') return;

      const p = event.payload as { taskId: string; dropReason: string };

      // Only close rows for drops that came from the supersede path.
      if (!p.dropReason.startsWith('superseded by new task')) return;

      const { ran } = await processedOnce({
        client,
        subscriberId: DROPPED_VIA_SUPERSEDE_CLEARER_SUBSCRIBER,
        eventId: event.id,
        sideEffect: async (_tx) => {
          // Event-level dedup only; the action-queue write happens outside.
        },
      });
      if (!ran) return;

      await supersedeActionQueueItemsForOrigin(
        p.taskId,
        'origin-dropped',
        `outbox:${DROPPED_VIA_SUPERSEDE_CLEARER_SUBSCRIBER}`,
      );
    },
  };
}

/**
 * Resolve the open `api-outage` row for the given circuit-breaker `openedAt`
 * timestamp once all affected tasks are no longer in `'failed'` state.
 *
 * Call this when the API circuit breaker closes. Callers should capture
 * `apiCircuitBreaker.state().openedAt` before calling `apiCircuitBreaker.close()`
 * (which resets `openedAt` to null), then pass it here.
 *
 * The row is resolved only when every task id recorded in
 * `payload.occurrences` has a status other than `'failed'` (or no longer
 * exists). Tasks that are still `'failed'` keep the row open so the operator
 * can act on the remaining failures.
 *
 * Idempotent — safe to call multiple times; no-op when the row is already
 * resolved or when no matching open row exists.
 */
export async function resolveOutageRowOnBreakerClose(openedAt: number): Promise<void> {
  const c = resolveStateClient();
  const signature = `api-outage:${openedAt}`;

  const existing = await c.execute({
    sql: `SELECT id, payload FROM action_queue_items
           WHERE kind = 'api-outage' AND signature = ? AND state = 'open'
           LIMIT 1`,
    args: [signature],
  });
  if (existing.rows.length === 0) return;

  const row = existing.rows[0] as unknown as { id: string; payload: string | null };

  let occurrences: Array<{ taskId?: string }> = [];
  try {
    const parsed = JSON.parse(row.payload ?? '{}') as Record<string, unknown>;
    if (Array.isArray(parsed.occurrences)) {
      occurrences = parsed.occurrences as Array<{ taskId?: string }>;
    }
  } catch {
    // Malformed payload — treat all tasks as drained and resolve.
  }

  const taskIds = occurrences.map((o) => o.taskId).filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (taskIds.length > 0) {
    const placeholders = taskIds.map(() => '?').join(',');
    const failedCheck = await c.execute({
      sql: `SELECT id FROM tasks WHERE id IN (${placeholders}) AND status = 'failed'`,
      args: taskIds,
    });
    if (failedCheck.rows.length > 0) return; // at least one task still draining
  }

  await setActionQueueState(row.id, 'resolved', {
    note: 'api-outage resolved: circuit breaker closed and all affected tasks drained',
    by: 'outbox:action-queue-raiser:breaker-closed',
  });
}
