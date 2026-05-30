/**
 * transcript-append Outbox Subscriber — behaviour tests.
 *
 * These tests drive the subscriber handler directly (without a running
 * dispatcher) so every assertion is synchronous and deterministic. The
 * file-backed SQLite client mirrors the real daemon setup: a single
 * `mars.db` that holds both the `trace_events` table and the
 * `subscriber_processed_events` dedup table, so the processedOnce row and
 * the transcript insert are co-located and covered by the same write
 * transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  buildTranscriptAppendSubscriber,
  ensureTranscriptAppendSchema,
} from './transcript-append.js';
import type { BusEvent } from '../../bus/events.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Construct a minimal `task.completed` BusEvent. */
function completedEvent(eventId: number, taskId: string): BusEvent {
  return {
    id: eventId,
    type: 'task.completed',
    payload: { taskId, result: null },
    ts: 1_000,
  };
}

/** Count trace_events rows for the given taskId. */
async function traceEventCount(client: Client, taskId: string): Promise<number> {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM trace_events WHERE task_id = ?`,
    args: [taskId],
  });
  return Number((r.rows[0] as unknown as { n: number | bigint }).n);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transcript-append:task.completed subscriber', () => {
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-transcript-append-test-'));
    client = createClient({ url: `file:${join(tmpDir, 'mars.db')}` });
    await ensureTranscriptAppendSchema(client);
  });

  afterEach(() => {
    client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // Each run-completion event results in exactly one transcript append.

  it('inserts exactly one trace_events row for a task.completed event', async () => {
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'Hello' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    await subscriber.handler(completedEvent(1, 'task-alpha'));

    expect(await traceEventCount(client, 'task-alpha')).toBe(1);
  });

  it('stores the conversation JSON in the trace_events payload with expected metadata', async () => {
    const conv = JSON.stringify([{ role: 'assistant', content: 'some response' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, async () => conv);

    await subscriber.handler(completedEvent(2, 'task-bravo'));

    const r = await client.execute({
      sql: `SELECT payload FROM trace_events WHERE task_id = ?`,
      args: ['task-bravo'],
    });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as unknown as { payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.transcript).toBe(conv);
    expect(payload.stepName).toBe('code');
    expect(payload.outcome).toBe('success');
  });

  // ── Acceptance criterion 2 ─────────────────────────────────────────────
  // Killing the daemon between the run completing and the transcript append,
  // then restarting, still produces exactly one append.

  it('after a restart with no prior processing, the first delivery creates exactly one row', async () => {
    // Simulates: event written to outbox, daemon crashes before subscriber
    // processes it (processedOnce dedup table is empty). On restart a fresh
    // subscriber instance processes the event and the trace_events row appears.
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'text' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    await subscriber.handler(completedEvent(10, 'task-charlie'));

    expect(await traceEventCount(client, 'task-charlie')).toBe(1);
  });

  it('processedOnce dedup persists across subscriber instances, preventing a double-append on restart', async () => {
    // Simulates: first subscriber instance processes the event successfully
    // (processedOnce commits dedup row + trace_events row) but cursor advance
    // fails before the daemon dies. On restart a second subscriber instance
    // sees the same event (cursor still behind). The persisted dedup row must
    // prevent a second trace_events row.
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'x' }]);

    const sub1 = buildTranscriptAppendSubscriber(client, readTranscript);
    await sub1.handler(completedEvent(7, 'task-delta'));
    expect(await traceEventCount(client, 'task-delta')).toBe(1);

    // Restart: new subscriber instance, same file-backed DB (dedup row persists).
    const sub2 = buildTranscriptAppendSubscriber(client, readTranscript);
    await sub2.handler(completedEvent(7, 'task-delta'));

    // Persisted dedup row prevented the second insert.
    expect(await traceEventCount(client, 'task-delta')).toBe(1);
  });

  // ── Acceptance criterion 3 ─────────────────────────────────────────────
  // Replaying a run-completion event produces zero additional appends.

  it('replaying the same event id produces zero additional trace_events rows', async () => {
    const event = completedEvent(42, 'task-echo');
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'y' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    // First delivery.
    await subscriber.handler(event);
    expect(await traceEventCount(client, 'task-echo')).toBe(1);

    // Replay — same event id, same subscriber.
    await subscriber.handler(event);

    // processedOnce dedup row prevents re-entry.
    expect(await traceEventCount(client, 'task-echo')).toBe(1);
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

    expect(await traceEventCount(client, 'task-foxtrot')).toBe(0);
  });

  it('skips the append without error when readTranscript returns null', async () => {
    const subscriber = buildTranscriptAppendSubscriber(client, async () => null);

    await subscriber.handler(completedEvent(5, 'task-golf'));

    expect(await traceEventCount(client, 'task-golf')).toBe(0);
  });

  it('different tasks each get their own trace_events row', async () => {
    const readTranscript = async () =>
      JSON.stringify([{ role: 'assistant', content: 'z' }]);
    const subscriber = buildTranscriptAppendSubscriber(client, readTranscript);

    await subscriber.handler(completedEvent(20, 'task-hotel'));
    await subscriber.handler(completedEvent(21, 'task-india'));

    expect(await traceEventCount(client, 'task-hotel')).toBe(1);
    expect(await traceEventCount(client, 'task-india')).toBe(1);
  });
});
