/**
 * transcript-append Outbox Subscriber — behaviour tests.
 *
 * These tests drive the subscriber handler directly (without a running
 * dispatcher) so every assertion is synchronous and deterministic. One
 * database per test mirrors the real daemon setup: a single store that
 * holds both the `task_durable_transcripts` table and the
 * `subscriber_processed_events` dedup table, so the processedOnce row and
 * the transcript insert are co-located and covered by the same write
 * transaction.
 *
 * Since the durable-transcript migration, transcripts are stored as
 * gzip-compressed `bytea` values in `task_durable_transcripts` — not as
 * JSON strings inside `trace_events` payloads. All assertions check that
 * table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { openDb, type DbClient } from '../../core/lib/db.js';
import { ensureSchema } from '../../core/lib/pg-schema.js';
import { buildTranscriptAppendSubscriber } from './transcript-append.js';
import type { BusEvent } from '../../bus/events.js';

const gunzipAsync = promisify(gunzip);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let dbSeq = 0;

/**
 * Fresh in-memory PGlite instance per test carrying the canonical schema
 * (MARS_DB_BACKEND=pglite is set by test/setup-env.ts; the target string is
 * only an identity key).
 */
async function makeClient(): Promise<DbClient> {
  const client = openDb(`test:transcript-append:${process.pid}:${dbSeq++}`);
  await ensureSchema(client);
  return client;
}

/** Construct a minimal `task.completed` BusEvent. */
function completedEvent(eventId: number, taskId: string): BusEvent {
  return {
    id: eventId,
    type: 'task.completed',
    payload: { taskId, result: null },
    ts: 1_000,
  };
}

/** Count task_durable_transcripts rows for the given taskId. */
async function durableTranscriptCount(client: DbClient, taskId: string): Promise<number> {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM task_durable_transcripts WHERE task_id = ?`,
    args: [taskId],
  });
  return Number((r.rows[0] as unknown as { n: number | bigint }).n);
}

/** Read and decompress the stored transcript for a task. Returns null if not present. */
async function readDurableTranscript(client: DbClient, taskId: string): Promise<string | null> {
  const r = await client.execute({
    sql: `SELECT transcript FROM task_durable_transcripts WHERE task_id = ?`,
    args: [taskId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as unknown as { transcript: Uint8Array | null };
  if (!row.transcript) return null;
  const decompressed = await gunzipAsync(Buffer.from(row.transcript));
  return decompressed.toString('utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transcript-append:task.completed subscriber', () => {
  let client: DbClient;

  beforeEach(async () => {
    client = await makeClient();
  });

  afterEach(async () => {
    await client.close();
  });

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // Each run-completion event results in exactly one compressed transcript row
  // in task_durable_transcripts.

  it('inserts exactly one task_durable_transcripts row for a task.completed event', async () => {
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'Hello' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    await subscriber.handler(completedEvent(1, 'task-alpha'));

    expect(await durableTranscriptCount(client, 'task-alpha')).toBe(1);
    const row = await client.execute({
      sql: `SELECT created_at FROM task_durable_transcripts WHERE task_id = ?`,
      args: ['task-alpha'],
    });
    expect(typeof row.rows[0].created_at).toBe('number');
  });

  it('stores the conversation JSON as a gzip-compressed BLOB in task_durable_transcripts', async () => {
    const conv = JSON.stringify([{ role: 'assistant', content: 'some response' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, async () => conv);

    await subscriber.handler(completedEvent(2, 'task-bravo'));

    expect(await durableTranscriptCount(client, 'task-bravo')).toBe(1);
    const stored = await readDurableTranscript(client, 'task-bravo');
    expect(stored).toBe(conv);
  });

  // ── Acceptance criterion 2 ─────────────────────────────────────────────
  // Killing the daemon between the run completing and the transcript append,
  // then restarting, still produces exactly one append.

  it('after a restart with no prior processing, the first delivery creates exactly one row', async () => {
    // Simulates: event written to outbox, daemon crashes before subscriber
    // processes it (processedOnce dedup table is empty). On restart a fresh
    // subscriber instance processes the event and the row in
    // task_durable_transcripts appears.
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'text' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    await subscriber.handler(completedEvent(10, 'task-charlie'));

    expect(await durableTranscriptCount(client, 'task-charlie')).toBe(1);
  });

  it('processedOnce dedup persists across subscriber instances, preventing a double-append on restart', async () => {
    // Simulates: first subscriber instance processes the event successfully
    // (processedOnce commits dedup row + task_durable_transcripts row) but
    // cursor advance fails before the daemon dies. On restart a second subscriber
    // instance sees the same event (cursor still behind). The persisted dedup row
    // must prevent a second INSERT into task_durable_transcripts.
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'x' }]);

    const sub1 = buildTranscriptAppendSubscriber(client, readTranscript);
    await sub1.handler(completedEvent(7, 'task-delta'));
    expect(await durableTranscriptCount(client, 'task-delta')).toBe(1);

    // Restart: new subscriber instance, same file-backed DB (dedup row persists).
    const sub2 = buildTranscriptAppendSubscriber(client, readTranscript);
    await sub2.handler(completedEvent(7, 'task-delta'));

    // Persisted dedup row prevented the second insert.
    expect(await durableTranscriptCount(client, 'task-delta')).toBe(1);
  });

  // ── Acceptance criterion 3 ─────────────────────────────────────────────
  // Replaying a run-completion event produces zero additional appends.

  it('replaying the same event id produces zero additional task_durable_transcripts rows', async () => {
    const event = completedEvent(42, 'task-echo');
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'y' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    // First delivery.
    await subscriber.handler(event);
    expect(await durableTranscriptCount(client, 'task-echo')).toBe(1);

    // Replay — same event id, same subscriber.
    await subscriber.handler(event);

    // processedOnce dedup row prevents re-entry.
    expect(await durableTranscriptCount(client, 'task-echo')).toBe(1);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it('ignores non-task.completed events without inserting any row', async () => {
    const readTranscript = async () => {
      throw new Error('readTranscript should not be called for non-completion events');
    };
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    const otherEvent: BusEvent = {
      id: 99,
      type: 'task.blocked',
      payload: {
        taskId: 'task-foxtrot',
        fixTaskId: null,
        failureSignature: 'sig',
        failingStep: 'verify',
      },
      ts: 1_000,
    };
    await subscriber.handler(otherEvent);

    expect(await durableTranscriptCount(client, 'task-foxtrot')).toBe(0);
  });

  it('skips the append without error when readTranscript returns null', async () => {
    const subscriber = buildTranscriptAppendSubscriber(client, async () => null);

    await subscriber.handler(completedEvent(5, 'task-golf'));

    expect(await durableTranscriptCount(client, 'task-golf')).toBe(0);
  });

  it('different tasks each get their own task_durable_transcripts row', async () => {
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'z' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    await subscriber.handler(completedEvent(20, 'task-hotel'));
    await subscriber.handler(completedEvent(21, 'task-india'));

    expect(await durableTranscriptCount(client, 'task-hotel')).toBe(1);
    expect(await durableTranscriptCount(client, 'task-india')).toBe(1);
  });

  // ── EventEmitter wiring ───────────────────────────────────────────────────
  // Confirms the daemon bus.on('task.completed', ...) pattern works correctly:
  // emitting task.completed on an EventEmitter triggers the subscriber and
  // writes exactly one task_durable_transcripts row.

  it('bus.on wiring: emitting task.completed via EventEmitter writes exactly one task_durable_transcripts row (test (a))', async () => {
    const emitter = new EventEmitter()
    const readTranscript = async () =>
      JSON.stringify([{ type: 'assistant', content: 'wired' }])
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript)

    // Reproduce the daemon bus.on registration pattern from server.ts.
    let nextId = 0
    const pending: Promise<void>[] = []
    emitter.on('task.completed', ({ taskId }: { taskId: string }) => {
      const id = nextId++
      pending.push(
        subscriber.handler({
          id,
          type: 'task.completed',
          payload: { taskId, result: null },
          ts: Date.now(),
        } as BusEvent),
      )
    })

    emitter.emit('task.completed', { taskId: 'task-emitter-wired', status: 'done' })
    await Promise.all(pending)

    expect(await durableTranscriptCount(client, 'task-emitter-wired')).toBe(1)
  })
});
