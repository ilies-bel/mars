import type { DbClient } from '../../core/lib/db.js';
import { processedOnce } from '../../bus/processed-once.js';
import type { BusEvent } from '../../bus/events.js';
import type { Subscriber } from '../dispatcher.js';
import { publish } from '../../bus/publisher.js';
import { registerSubscriberName } from '../registry.js';

/**
 * Build the Outbox Subscribers that durably record signals in reaction to
 * state-change events.
 *
 * Each subscriber wraps its handler in {@link processedOnce} so that
 * replaying the same event id never produces additional signal records. The
 * {@link processedOnce} dedup row and the signal write land in the same
 * write transaction on `client`, so a daemon restart between the outbox
 * write and the signal record cannot result in a missing or duplicate
 * record — either both commit or neither does.
 *
 * @param client  The shared DB client. Must hold the outbox `events`
 *   table and the `signals` table so all writes are co-located and the dedup
 *   transaction is cross-table atomic.
 */
export function buildSignalRecordingSubscribers(client: DbClient): Subscriber[] {
  return [taskTerminalSignalRecorder(client)];
}

export const TASK_TERMINAL_SUBSCRIBER = 'signal-recording:task.terminal';
registerSubscriberName(TASK_TERMINAL_SUBSCRIBER);

/**
 * Subscriber that converts `task.terminal` outbox events into durable signal
 * records. One record per terminal event; the `processedOnce` dedup table
 * structurally prevents duplicate writes across restarts and replays.
 *
 * The signal `kind` encodes the terminal reason (e.g. `task.terminal:done`),
 * and a `signal.recorded` event is published atomically alongside the row so
 * downstream subscribers can react without polling the `signals` table.
 */
function taskTerminalSignalRecorder(client: DbClient): Subscriber {
  return {
    name: TASK_TERMINAL_SUBSCRIBER,
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'task.terminal') return;

      const p = event.payload as { taskId: string; reason: string };
      const kind = `task.terminal:${p.reason}`;

      await processedOnce({
        client,
        subscriberId: TASK_TERMINAL_SUBSCRIBER,
        eventId: event.id,
        sideEffect: async (tx) => {
          await tx.execute({
            sql: `INSERT INTO signals (id, task_id, kind) VALUES (?, ?, ?)`,
            args: [`${p.taskId}:${event.id}`, p.taskId, kind],
          });
          await publish(tx, 'signal.recorded', { taskId: p.taskId, kind });
        },
      });
    },
  };
}
