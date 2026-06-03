import type { Client } from '@libsql/client';
import { genId } from '../../mars-id/index.js';
import {
  processedOnce,
  ensureProcessedOnceSchema,
} from '../../bus/processed-once.js';
import type { Subscriber } from '../dispatcher.js';
import type { BusEvent } from '../../bus/events.js';

/**
 * Ensure the schema required by the question-raise subscriber is present on
 * `client`. Creates the `subscriber_processed_events` dedup table if it does
 * not exist. Idempotent — safe to call on every startup.
 */
export async function ensureQuestionRaiseSchema(client: Client): Promise<void> {
  await ensureProcessedOnceSchema(client);
}

/**
 * Build the Outbox Subscriber that durably raises action-queue (inbox) items
 * in reaction to `task.question` events emitted by a coder during task
 * execution.
 *
 * The subscriber wraps its handler in {@link processedOnce} so that replaying
 * the same event id never produces additional inbox rows. The dedup row and
 * the inbox write land in the same write transaction on `client`, so a daemon
 * restart between the outbox write and the inbox raise cannot result in a
 * missing or duplicate item — either both commit or neither does.
 *
 * Each question event produces its own inbox row (no origin-fingerprint
 * collapse — questions are independent operator tasks).
 *
 * @param client  The shared `mars.db` client. Must hold both the outbox
 *   `events` table and the `action_queue_items` / `action_queue_history`
 *   tables so all writes are co-located and the dedup transaction is
 *   cross-table atomic.
 */
export function buildQuestionRaiseSubscribers(client: Client): Subscriber[] {
  return [questionRaiseSubscriber(client)];
}

/**
 * Subscriber that converts `task.question` outbox events into durable
 * action-queue inbox items. Each question event produces exactly one open
 * item; replaying the same event id is structurally blocked by
 * processedOnce's dedup row.
 */
function questionRaiseSubscriber(client: Client): Subscriber {
  return {
    name: 'question-raiser:task.question',
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'task.question') return;

      const p = event.payload as {
        taskId: string;
        question: string;
      };
      const now = new Date().toISOString();
      const raisedBy = 'outbox:question-raiser:task.question';

      await processedOnce({
        client,
        subscriberId: 'question-raiser:task.question',
        eventId: event.id,
        sideEffect: async (tx) => {
          const id = genId('inbox-item').toString();
          await tx.execute({
            sql: `INSERT INTO action_queue_items (
                   id, kind, category, priority, state,
                   title, body, payload, context,
                   raised_by, raised_at, last_seen_at, seen_count,
                   fingerprint, signature, origin_task_id
                 ) VALUES (
                   ?, 'coder-question', 'orchestrator', 'high', 'open',
                   ?, ?, ?, '{}',
                   ?, ?, ?, 1,
                   NULL, ?, ?
                 )`,
            args: [
              id,
              `Question from task ${p.taskId}`,
              p.question,
              JSON.stringify({ taskId: p.taskId, question: p.question }),
              raisedBy,
              now,
              now,
              p.taskId,
              p.taskId,
            ],
          });
          await tx.execute({
            sql: `INSERT INTO action_queue_history (
                   id, item_id, at, from_state, to_state, by, note
                 ) VALUES (?, ?, ?, NULL, 'open', ?, NULL)`,
            args: [genId('inbox-history').toString(), id, now, raisedBy],
          });
        },
      });
    },
  };
}
