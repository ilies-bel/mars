import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { DbClient } from '../../core/lib/db.js';
import { processedOnce } from '../../bus/processed-once.js';
import type { Subscriber } from '../dispatcher.js';
import type { BusEvent } from '../../bus/events.js';
import { registerSubscriberName } from '../registry.js';

const gzipAsync = promisify(gzip);

/** Unique name for the durable transcript-append subscriber. */
export const TRANSCRIPT_APPEND_SUBSCRIBER_ID =
  'transcript-append:task.completed';
registerSubscriberName(TRANSCRIPT_APPEND_SUBSCRIBER_ID);

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
 * Build the durable Outbox Subscriber that appends a completed task's
 * Claude transcript to `task_durable_transcripts` as a gzip-compressed
 * `bytea` value.
 *
 * The handler is wrapped in {@link processedOnce} so that replaying the
 * same `task.completed` event id never produces duplicate rows — exactly-once
 * delivery is structural, not convention-policed.
 *
 * Compression happens BEFORE entering the transaction (it is CPU-bound and
 * idempotent) so the DB transaction stays fast and free of blocking I/O.
 *
 * A daemon crash between the `task.completed` event being written to the
 * outbox and the transcript being stored will be recovered on restart: the
 * dispatcher re-delivers the event (the cursor has not advanced) and the
 * handler runs again. Because no dedup row was committed before the crash,
 * `processedOnce` allows the sideEffect to run on the second attempt and
 * exactly one row is written.
 *
 * @param client          The DB client. Must hold both
 *   `task_durable_transcripts` and `subscriber_processed_events` so the
 *   dedup row and transcript insert are covered by the same write transaction.
 * @param readTranscript  Filesystem boundary — reads the Claude Code
 *   transcript for the task identified by `taskId`. Returns `null` when
 *   no transcript is available; the event cursor still advances so it is
 *   not re-delivered.
 */
export function buildTranscriptAppendSubscriber(
  client: DbClient,
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

      const now = Date.now();
      const byteLen = conversationJson.length;
      // Compress before the transaction: gzip is CPU-bound and must not block
      // the DB transaction body.
      const compressed = await gzipAsync(Buffer.from(conversationJson, 'utf8'));

      await processedOnce({
        client,
        subscriberId: TRANSCRIPT_APPEND_SUBSCRIBER_ID,
        eventId: event.id,
        sideEffect: async (tx) => {
          // ON CONFLICT DO NOTHING: if runWorkerWithSpan already wrote a
          // durable transcript for this task, leave the existing row intact.
          await tx.execute({
            sql: `INSERT INTO task_durable_transcripts
                    (task_id, session_id, step_name, created_at, transcript, byte_len)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT (task_id) DO NOTHING`,
            args: [taskId, '', 'code', now, compressed, byteLen],
          });
        },
      });
    },
  };
}
