import type { Client } from '@libsql/client';
import {
  processedOnce,
  ensureProcessedOnceSchema,
} from '../../bus/processed-once.js';
import type { Subscriber } from '../dispatcher.js';
import type { BusEvent } from '../../bus/events.js';
import { raiseActionQueueItem } from '../../core/lib/action-queue.js';

/**
 * Ensure the schema required by action-queue-raiser subscribers is present on
 * `client`. Creates the `subscriber_processed_events` dedup table if it does
 * not exist. Idempotent — safe to call on every startup.
 */
export async function ensureActionQueueRaiserSchema(client: Client): Promise<void> {
  await ensureProcessedOnceSchema(client);
}

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
 * @param client  The shared `mars.db` client used for the per-subscriber
 *   processedOnce dedup table.
 */
export function buildActionQueueRaiserSubscribers(client: Client): Subscriber[] {
  return [taskBlockedActionQueueRaiser(client)];
}

/**
 * Subscriber that converts `task.blocked` outbox events into durable
 * action-queue items. One open item per arc origin (origin-fingerprint
 * dedup inside {@link raiseActionQueueItem}); a subsequent `task.blocked`
 * event for the same arc bumps `seen_count` on the existing open row rather
 * than inserting a duplicate.
 *
 * Fix/descendant tasks (where `originId` is absent from the payload but the
 * task row carries an `origin_id` in the DB) are resolved to their arc root
 * internally by `raiseActionQueueItem` via `resolveOriginIdForTask`, so one
 * arc surfaces as exactly one row regardless of which slice triggered the
 * block.
 */
function taskBlockedActionQueueRaiser(client: Client): Subscriber {
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

      // Route through the single raise path (ADR-0051): raiseActionQueueItem
      // calls resolveOriginIdForTask(originTaskId) internally so fix/descendant
      // tasks collapse onto their arc root. We pass originTaskId raw and avoid
      // double-resolution at the call site.
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
        },
        context: {},
        raisedBy: 'outbox:action-queue-raiser:task.blocked',
        signature: `task.blocked:${p.taskId}`,
        originTaskId: p.originId ?? p.taskId,
      });
    },
  };
}
