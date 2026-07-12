import type { Client } from '@libsql/client';
import {
  registerSubscriber,
  fetchPending,
  advanceCursor,
} from '../../bus/subscribers.js';
import { registerSubscriberName } from '../registry.js';

/**
 * The Invalidator: a durable Outbox Subscriber that auto-closes
 * `subscriber_stalls` rows when the condition that raised them resolves.
 *
 * When a Subscriber's handler stalls (STALL_THRESHOLD consecutive failures on
 * the same event id), `startStallAwareDispatcher` inserts a
 * `subscriber_stalls` row AND publishes a `subscriber.stalled` event.
 * When the handler eventually succeeds, it publishes `subscriber.unstalled`
 * to the Outbox. The Invalidator consumes `subscriber.unstalled` events from
 * its durable cursor and deletes the corresponding stall row.
 *
 * Durability guarantee: if the daemon is killed after the `subscriber.unstalled`
 * event is written but before this subscriber processes it, the event is
 * replayed from the cursor on the next startup and the row is closed then.
 */
export const INVALIDATOR_SUBSCRIBER = 'stall-invalidator';
registerSubscriberName(INVALIDATOR_SUBSCRIBER);

/**
 * Register the Invalidator subscriber. `replay: false` (tail default) so a
 * fresh cursor observes only future events. Idempotent — re-registering an
 * existing subscriber is a no-op.
 */
export async function ensureInvalidator(client: Client): Promise<void> {
  await registerSubscriber(client, INVALIDATOR_SUBSCRIBER, { replay: false });
}

/**
 * Process every `subscriber.unstalled` event the Invalidator has not yet
 * acknowledged, closing the corresponding `subscriber_stalls` row for each.
 * All other event types advance the cursor without side effect.
 *
 * @param client  The libsql client carrying the outbox and subscriber_stalls tables.
 * @returns       The count of stall rows that were closed.
 */
export async function drainInvalidations(
  client: Client,
): Promise<{ processed: number }> {
  const pending = await fetchPending(client, INVALIDATOR_SUBSCRIBER);
  let processed = 0;

  for (const event of pending) {
    if (event.type === 'subscriber.unstalled') {
      const { subscriberId, eventId } = event.payload as {
        subscriberId: string;
        eventId: number;
      };
      await client.execute({
        sql: 'DELETE FROM subscriber_stalls WHERE subscriber_id = ? AND event_id = ?',
        args: [subscriberId, eventId],
      });
      processed++;
    }
    await advanceCursor(client, INVALIDATOR_SUBSCRIBER, event.id);
  }

  return { processed };
}
