/**
 * Signal-recording Outbox Subscriber — behaviour tests.
 *
 * Tests drive the subscriber handlers directly (without a running dispatcher)
 * for synchronous, deterministic assertions. One database per test mirrors
 * the real daemon setup: a single store that holds both the outbox `events`
 * table and the `signals` table so the processedOnce dedup row and the
 * signal write are co-located and covered by the same write transaction.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type DbClient } from '../../core/lib/db.js';
import { getTestDb } from '../../../test/db-fixture.js';
import { buildSignalRecordingSubscribers } from './signal-recording.js';
import type { BusEvent } from '../../bus/events.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Construct a minimal `task.terminal` BusEvent. */
function terminalEvent(
  eventId: number,
  taskId: string,
  reason: 'done' | 'dropped' | 'failed' | 'purged' = 'done',
): BusEvent {
  return {
    id: eventId,
    type: 'task.terminal',
    payload: { taskId, reason },
    ts: 1_000,
  };
}

/** Count all rows in the `signals` table. */
async function signalCount(client: DbClient): Promise<number> {
  const r = await client.execute(`SELECT COUNT(*) AS n FROM signals`);
  return Number((r.rows[0] as unknown as { n: number | bigint }).n);
}

/** Return the signal row for `taskId`, or null if absent. */
async function signalForTask(
  client: DbClient,
  taskId: string,
): Promise<{ kind: string } | null> {
  const r = await client.execute({
    sql: `SELECT kind FROM signals WHERE task_id = ? LIMIT 1`,
    args: [taskId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as unknown as { kind: string };
  return { kind: row.kind };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signal-recording:task.terminal subscriber', () => {
  let client: DbClient;

  beforeEach(async () => {
    client = await getTestDb();
  });

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // Each originating event results in exactly one signal record.

  it('records exactly one signal when a task.terminal event is processed', async () => {
    const [subscriber] = buildSignalRecordingSubscribers(client);
    await subscriber.handler(terminalEvent(1, 'task-alpha'));

    expect(await signalCount(client)).toBe(1);
    const signal = await signalForTask(client, 'task-alpha');
    expect(signal).not.toBeNull();
    expect(signal!.kind).toBe('task.terminal:done');
  });

  it('encodes the terminal reason in the signal kind', async () => {
    const [subscriber] = buildSignalRecordingSubscribers(client);
    await subscriber.handler(terminalEvent(2, 'task-bravo', 'failed'));

    const signal = await signalForTask(client, 'task-bravo');
    expect(signal!.kind).toBe('task.terminal:failed');
  });

  it('publishes a signal.recorded event atomically with the signal row', async () => {
    const [subscriber] = buildSignalRecordingSubscribers(client);
    await subscriber.handler(terminalEvent(3, 'task-charlie'));

    const r = await client.execute({
      sql: `SELECT payload FROM events WHERE type = 'signal.recorded' LIMIT 1`,
    });
    expect(r.rows).toHaveLength(1);
    const payload = JSON.parse(
      (r.rows[0] as unknown as { payload: string }).payload,
    ) as { taskId: string; kind: string };
    expect(payload.taskId).toBe('task-charlie');
    expect(payload.kind).toBe('task.terminal:done');
  });

  it('each distinct terminal event produces its own signal record', async () => {
    const [subscriber] = buildSignalRecordingSubscribers(client);
    await subscriber.handler(terminalEvent(1, 'task-delta', 'done'));
    await subscriber.handler(terminalEvent(2, 'task-echo', 'failed'));

    expect(await signalCount(client)).toBe(2);
  });

  // ── Acceptance criterion 2 (daemon restart) ────────────────────────────
  // A daemon restart between the originating event and the signal record
  // still results in exactly one record.

  it('first delivery after a restart creates exactly one record', async () => {
    // Simulates: event written to outbox, daemon crashes before subscriber
    // processes it (processedOnce dedup table is empty). On restart a fresh
    // subscriber instance processes the event and the signal row appears.
    const event = terminalEvent(10, 'task-foxtrot');
    const [subscriber] = buildSignalRecordingSubscribers(client);
    await subscriber.handler(event);

    expect(await signalCount(client)).toBe(1);
  });

  it('processedOnce dedup persists across subscriber instances, preventing a double-write on restart', async () => {
    // Simulates: first subscriber instance processes the event successfully
    // (processedOnce commits dedup row + signal row) but the cursor advance
    // fails before the daemon dies. On restart a second subscriber instance
    // sees the same event (cursor still behind). The persisted dedup row
    // must prevent a second signal write.
    const event = terminalEvent(7, 'task-golf');

    const [sub1] = buildSignalRecordingSubscribers(client);
    await sub1.handler(event);
    expect(await signalCount(client)).toBe(1);

    // Restart: new subscriber instance, same file-backed DB (dedup row persists).
    const [sub2] = buildSignalRecordingSubscribers(client);
    await sub2.handler(event);

    // Dedup row prevented re-write: still exactly one signal.
    expect(await signalCount(client)).toBe(1);
  });

  // ── Acceptance criterion 3 ─────────────────────────────────────────────
  // Replaying the originating event produces zero additional signal records.

  it('replaying the same event id produces zero additional signal records', async () => {
    const event = terminalEvent(42, 'task-hotel');
    const [subscriber] = buildSignalRecordingSubscribers(client);

    // First delivery
    await subscriber.handler(event);
    expect(await signalCount(client)).toBe(1);

    // Replay — same event id, same subscriber
    await subscriber.handler(event);

    // processedOnce dedup row prevents re-entry: still exactly one signal
    expect(await signalCount(client)).toBe(1);
  });

  // ── Non-matching events ────────────────────────────────────────────────

  it('ignores events that are not task.terminal', async () => {
    const [subscriber] = buildSignalRecordingSubscribers(client);
    const unrelated: BusEvent = {
      id: 99,
      type: 'task.created',
      payload: { taskId: 'task-india', title: 'Some task' },
      ts: 1_000,
    };
    await subscriber.handler(unrelated);

    expect(await signalCount(client)).toBe(0);
  });
});
