import type { Client } from '@libsql/client';
import {
  processedOnce,
  ensureProcessedOnceSchema,
} from '../../bus/processed-once.js';
import type { Subscriber } from '../dispatcher.js';
import type { BusEvent } from '../../bus/events.js';

/** Unique name for the durable transcript-append subscriber. */
export const TRANSCRIPT_APPEND_SUBSCRIBER_ID =
  'transcript-append:task.completed';

/**
 * Reads the Claude Code transcript for a completed task and returns its
 * content as a JSON string, or `null` if no transcript is available.
 *
 * Injected at construction so tests can stub the filesystem boundary
 * without touching `~/.claude/projects/`. In production, wire this to
 * a reader built from {@link readAllTranscriptsForTask}.
 */
export type ReadTranscript = (taskId: string) => Promise<string | null>;

/**
 * Ensure the DB schema required by the transcript-append subscriber exists.
 *
 * Creates:
 * - `subscriber_processed_events` — processedOnce dedup table
 * - `trace_events` — transcript storage destination
 *
 * Idempotent — safe to call on every daemon startup.
 */
export async function ensureTranscriptAppendSchema(
  client: Client,
): Promise<void> {
  await ensureProcessedOnceSchema(client);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS trace_events (
      id        TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      kind      TEXT NOT NULL,
      severity  TEXT NOT NULL DEFAULT 'info',
      task_id   TEXT,
      origin_id TEXT,
      phase     TEXT,
      payload   TEXT NOT NULL DEFAULT '{}'
    )
  `);
}

/**
 * Build the durable Outbox Subscriber that appends a completed task's
 * Claude transcript to the `trace_events` table.
 *
 * The handler is wrapped in {@link processedOnce} so that replaying the
 * same `task.completed` event id never produces additional `trace_events`
 * rows — exactly-once delivery is structural, not convention-policed.
 *
 * A daemon crash between the `task.completed` event being written to the
 * outbox and the transcript being stored in `trace_events` will be
 * recovered on restart: the dispatcher re-delivers the event (the cursor
 * has not advanced) and the handler runs again. Because no dedup row was
 * committed before the crash, `processedOnce` allows the sideEffect to
 * run on the second attempt and exactly one `trace_events` row is written.
 *
 * @param client          The `mars.db` client. Must hold both
 *   `trace_events` and `subscriber_processed_events` so the dedup row and
 *   transcript insert are covered by the same write transaction.
 * @param readTranscript  Filesystem boundary — reads the Claude Code
 *   transcript for the task identified by `taskId`. Returns `null` when
 *   no transcript is available; the event cursor still advances so it is
 *   not re-delivered.
 */
export function buildTranscriptAppendSubscriber(
  client: Client,
  readTranscript: ReadTranscript,
): Subscriber {
  return {
    name: TRANSCRIPT_APPEND_SUBSCRIBER_ID,
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'task.completed') return;

      const { taskId } = event.payload as { taskId: string };

      // Read the transcript before entering processedOnce: filesystem reads
      // are idempotent and must not run inside the DB transaction.
      const conversationJson = await readTranscript(taskId);

      // Nothing to append — advance the cursor without a dedup row so this
      // event is not replayed and does not hold up the subscriber.
      if (conversationJson === null) return;

      const now = new Date().toISOString();
      // Deterministic row id: task + event id guarantee at-most-one row per
      // (task, event) pair even if the sideEffect is somehow run twice via a
      // path that bypasses processedOnce (defense in depth).
      const rowId = `transcript-append-${taskId}-${event.id}`;

      await processedOnce({
        client,
        subscriberId: TRANSCRIPT_APPEND_SUBSCRIBER_ID,
        eventId: event.id,
        sideEffect: async (tx) => {
          await tx.execute({
            sql: `INSERT INTO trace_events
                    (id, timestamp, kind, severity, task_id, phase, payload)
                  VALUES (?, ?, 'step_ended', 'info', ?, 'code', ?)`,
            args: [
              rowId,
              now,
              taskId,
              JSON.stringify({
                stepName: 'code',
                workflowInstanceId: `transcript-append-${taskId}`,
                outcome: 'success',
                durationMs: 0,
                transcript: conversationJson,
              }),
            ],
          });
        },
      });
    },
  };
}
