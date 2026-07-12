import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Client } from '@libsql/client';
import {
  processedOnce,
  ensureProcessedOnceSchema,
} from '../../bus/processed-once.js';
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
 * Ensure the DB schema required by the transcript-append subscriber exists.
 *
 * Creates:
 * - `subscriber_processed_events` — processedOnce dedup table
 * - `task_durable_transcripts` — compressed transcript storage destination
 *
 * Idempotent — safe to call on every daemon startup.
 */
export async function ensureTranscriptAppendSchema(
  client: Client,
): Promise<void> {
  await ensureProcessedOnceSchema(client);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS task_durable_transcripts (
      task_id    TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      step_name  TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      transcript BLOB NOT NULL,
      byte_len   INTEGER NOT NULL
    )
  `);
}

/**
 * Build the durable Outbox Subscriber that appends a completed task's
 * Claude transcript to `task_durable_transcripts` as a gzip-compressed BLOB.
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
 * @param client          The `mars.db` client. Must hold both
 *   `task_durable_transcripts` and `subscriber_processed_events` so the
 *   dedup row and transcript insert are covered by the same write transaction.
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
      const byteLen = conversationJson.length;
      // Compress before the transaction: gzip is CPU-bound and must not block
      // the DB transaction body.
      const compressed = await gzipAsync(Buffer.from(conversationJson, 'utf8'));

      await processedOnce({
        client,
        subscriberId: TRANSCRIPT_APPEND_SUBSCRIBER_ID,
        eventId: event.id,
        sideEffect: async (tx) => {
          // INSERT OR IGNORE: if runWorkerWithSpan already wrote a durable
          // transcript for this task, leave the newer compressed row intact.
          await tx.execute({
            sql: `INSERT OR IGNORE INTO task_durable_transcripts
                    (task_id, session_id, step_name, created_at, transcript, byte_len)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [taskId, '', 'code', now, compressed, byteLen],
          });
        },
      });
    },
  };
}
