import type { Client } from '@libsql/client';
import { createHash, randomUUID } from 'node:crypto';
import {
  processedOnce,
  ensureProcessedOnceSchema,
} from '../../bus/processed-once.js';
import type { Subscriber } from '../dispatcher.js';
import type { BusEvent } from '../../bus/events.js';

/** Hex SHA-1 of `input`. Mirrors the helper in action-queue.ts. */
const sha1Hex = (input: string): string =>
  createHash('sha1').update(input).digest('hex');

/** Origin-task fingerprint: matches the dedup key used by raiseActionQueueItem. */
const originFingerprint = (taskId: string): string =>
  sha1Hex(`origin:${taskId}`);

/**
 * Ensure the schema required by inbox-raiser subscribers is present on
 * `client`. Creates the `subscriber_processed_events` dedup table if it does
 * not exist. Idempotent — safe to call on every startup.
 */
export async function ensureInboxRaiserSchema(client: Client): Promise<void> {
  await ensureProcessedOnceSchema(client);
}

/**
 * Build the Outbox Subscribers that durably raise action-queue (inbox) items
 * in reaction to state-change events.
 *
 * Each subscriber wraps its handler in {@link processedOnce} so that
 * replaying the same event id never produces additional inbox rows. The
 * {@link processedOnce} dedup row and the inbox write land in the same
 * write transaction on `client`, so a daemon restart between the outbox
 * write and the inbox raise cannot result in a missing or duplicate item —
 * either both commit or neither does.
 *
 * @param client  The shared `mars.db` client. Must hold both the outbox
 *   `events` table and the `action_queue_items` / `action_queue_history`
 *   tables so all writes are co-located and the dedup transaction is
 *   cross-table atomic.
 */
export function buildInboxRaiserSubscribers(client: Client): Subscriber[] {
  return [taskBlockedInboxRaiser(client)];
}

/**
 * Subscriber that converts `task.blocked` outbox events into durable
 * action-queue inbox items. One open item per origin task (origin-fingerprint
 * dedup); a subsequent `task.blocked` event for the same task bumps
 * `seen_count` on the existing open row rather than inserting a duplicate.
 */
function taskBlockedInboxRaiser(client: Client): Subscriber {
  return {
    name: 'inbox-raiser:task.blocked',
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'task.blocked') return;

      const p = event.payload as {
        taskId: string;
        fixTaskId: string | null;
        failureSignature: string;
        failingStep: string;
      };
      const fingerprint = originFingerprint(p.taskId);
      const now = new Date().toISOString();
      const raisedBy = 'outbox:inbox-raiser:task.blocked';

      await processedOnce({
        client,
        subscriberId: 'inbox-raiser:task.blocked',
        eventId: event.id,
        sideEffect: async (tx) => {
          // Origin-fingerprint dedup: one open row per stuck task regardless
          // of how many task.blocked events have fired for it.
          const existing = await tx.execute({
            sql: `SELECT id FROM action_queue_items
                   WHERE fingerprint = ? AND state = 'open'
                   LIMIT 1`,
            args: [fingerprint],
          });

          if (existing.rows.length > 0) {
            const row = existing.rows[0] as unknown as { id: string };
            await tx.execute({
              sql: `UPDATE action_queue_items
                       SET seen_count = seen_count + 1,
                           last_seen_at = ?
                     WHERE id = ?`,
              args: [now, row.id],
            });
            return;
          }

          // No open item yet — insert a fresh one.
          const id = randomUUID().slice(0, 8);
          await tx.execute({
            sql: `INSERT INTO action_queue_items (
                   id, kind, category, priority, state,
                   title, body, payload, context,
                   raised_by, raised_at, last_seen_at, seen_count,
                   fingerprint, signature, origin_task_id
                 ) VALUES (
                   ?, 'failed', 'orchestrator', 'high', 'open',
                   ?, ?, ?, '{}',
                   ?, ?, ?, 1,
                   ?, ?, ?
                 )`,
            args: [
              id,
              `Task ${p.taskId} blocked`,
              `Task blocked at ${p.failingStep} with failure signature ${p.failureSignature}.`,
              JSON.stringify({
                taskId: p.taskId,
                failureSignature: p.failureSignature,
                failingStep: p.failingStep,
              }),
              raisedBy,
              now,
              now,
              fingerprint,
              p.taskId,
              p.taskId,
            ],
          });
          await tx.execute({
            sql: `INSERT INTO action_queue_history (
                   id, item_id, at, from_state, to_state, by, note
                 ) VALUES (?, ?, ?, NULL, 'open', ?, NULL)`,
            args: [randomUUID(), id, now, raisedBy],
          });
        },
      });
    },
  };
}
