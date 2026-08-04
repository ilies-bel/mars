/**
 * Question-raise Outbox Subscriber — behaviour tests.
 *
 * These tests drive the subscriber handler directly (without a running
 * dispatcher) so every assertion is synchronous and deterministic. One
 * database per test mirrors the real daemon setup: a single store that
 * holds both the outbox `events` table and the `action_queue_items` table,
 * so the processedOnce dedup row and the action-queue write are co-located
 * and covered by the same write transaction.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type DbClient } from '../../core/lib/db.js';
import { getTestDb } from '../../../test/db-fixture.js';
import { buildQuestionRaiseSubscribers } from './question-raise.js';
import type { BusEvent } from '../../bus/events.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Construct a minimal `task.question` BusEvent. */
function questionEvent(
  eventId: number,
  taskId: string,
  question = 'What should I do with the failing test?',
): BusEvent {
  return {
    id: eventId,
    type: 'task.question',
    payload: { taskId, question },
    ts: 1_000,
  };
}

/** Count open action-queue rows. */
async function openRowCount(client: DbClient): Promise<number> {
  const r = await client.execute(
    `SELECT COUNT(*) AS n FROM action_queue_items WHERE state = 'open'`,
  );
  return Number((r.rows[0] as unknown as { n: number | bigint }).n);
}

/** Return the open action-queue row for `taskId`, or null if absent. */
async function openRowForTask(
  client: DbClient,
  taskId: string,
): Promise<{ kind: string; seenCount: number; originTaskId: string } | null> {
  const r = await client.execute({
    sql: `SELECT kind, seen_count, origin_task_id
            FROM action_queue_items
           WHERE origin_task_id = ? AND state = 'open'
           LIMIT 1`,
    args: [taskId],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0] as unknown as {
    kind: string;
    seen_count: number | bigint;
    origin_task_id: string;
  };
  return {
    kind: row.kind,
    seenCount: Number(row.seen_count),
    originTaskId: row.origin_task_id,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('question-raiser:task.question subscriber', () => {
  let client: DbClient;

  beforeEach(async () => {
    client = await getTestDb();
  });

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // Each coder question event raises exactly one action-queue item.

  it('raises exactly one action-queue item when a task.question event is processed', async () => {
    const [subscriber] = buildQuestionRaiseSubscribers(client);
    await subscriber.handler(questionEvent(1, 'task-alpha'));

    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'task-alpha');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('coder-question');
    expect(row!.originTaskId).toBe('task-alpha');
  });

  it('records kind=coder-question, category=orchestrator, priority=high on the new row', async () => {
    const [subscriber] = buildQuestionRaiseSubscribers(client);
    await subscriber.handler(questionEvent(2, 'task-bravo'));

    const r = await client.execute({
      sql: `SELECT kind, category, priority FROM action_queue_items WHERE origin_task_id = ?`,
      args: ['task-bravo'],
    });
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0] as unknown as {
      kind: string;
      category: string;
      priority: string;
    };
    expect(row.kind).toBe('coder-question');
    expect(row.category).toBe('orchestrator');
    expect(row.priority).toBe('high');
  });

  it('stores the question text in the body column', async () => {
    const [subscriber] = buildQuestionRaiseSubscribers(client);
    const myQuestion = 'Should I use the outbox pattern here?';
    await subscriber.handler(questionEvent(3, 'task-charlie', myQuestion));

    const r = await client.execute({
      sql: `SELECT body FROM action_queue_items WHERE origin_task_id = ?`,
      args: ['task-charlie'],
    });
    expect(r.rows).toHaveLength(1);
    expect((r.rows[0] as unknown as { body: string }).body).toBe(myQuestion);
  });

  // ── Acceptance criterion 2 ─────────────────────────────────────────────
  // Replaying the same triggering event raises zero additional rows.

  it('replaying the same event id raises zero additional action-queue rows', async () => {
    const event = questionEvent(42, 'task-delta');
    const [subscriber] = buildQuestionRaiseSubscribers(client);

    // First delivery
    await subscriber.handler(event);
    expect(await openRowCount(client)).toBe(1);

    // Replay — same event id, same subscriber
    await subscriber.handler(event);

    // processedOnce dedup row prevents re-entry: still exactly one row
    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'task-delta');
    // seen_count must NOT have changed — processedOnce blocked re-entry
    // before the sideEffect even ran.
    expect(row!.seenCount).toBe(1);
  });

  // ── Acceptance criterion 3 ─────────────────────────────────────────────
  // A daemon restart between the state-write and the action-queue raise still
  // results in exactly one row appearing on next start.

  it('after a restart with no prior processing, the first delivery creates exactly one row', async () => {
    // Simulates: event written to outbox, daemon crashes before subscriber
    // processes it (processedOnce dedup table is empty). On restart a fresh
    // subscriber instance processes the event and the action-queue item appears.
    const event = questionEvent(99, 'task-echo');

    // Fresh subscriber — no dedup row in DB yet
    const [subscriber] = buildQuestionRaiseSubscribers(client);
    await subscriber.handler(event);

    expect(await openRowCount(client)).toBe(1);
  });

  it('processedOnce dedup persists across subscriber instances, preventing a double-raise on restart', async () => {
    // Simulates: first subscriber instance processes the event successfully
    // (processedOnce commits dedup row + action-queue write) but the cursor
    // advance fails before the daemon dies. On restart a second subscriber
    // instance sees the same event (cursor still behind). The persisted dedup
    // row must prevent a second action-queue raise.
    const event = questionEvent(7, 'task-foxtrot');

    const [sub1] = buildQuestionRaiseSubscribers(client);
    await sub1.handler(event);
    expect(await openRowCount(client)).toBe(1);

    // Restart: new subscriber instance, same file-backed DB (dedup row persists)
    const [sub2] = buildQuestionRaiseSubscribers(client);
    await sub2.handler(event);

    // Dedup row in DB prevented re-raise
    expect(await openRowCount(client)).toBe(1);
    expect((await openRowForTask(client, 'task-foxtrot'))!.seenCount).toBe(1);
  });

  // ── Independent questions ──────────────────────────────────────────────
  // Each distinct question event produces its own row (no origin-fingerprint
  // collapse — questions are independent operator tasks).

  it('two distinct task.question events for the same task produce two open rows', async () => {
    const [subscriber] = buildQuestionRaiseSubscribers(client);

    // Different event ids → processedOnce allows both, and no origin-fingerprint
    // collapse means two separate rows are inserted.
    await subscriber.handler(questionEvent(10, 'task-golf', 'First question?'));
    await subscriber.handler(questionEvent(11, 'task-golf', 'Second question?'));

    expect(await openRowCount(client)).toBe(2);
  });

  it('different tasks each get their own action-queue row', async () => {
    const [subscriber] = buildQuestionRaiseSubscribers(client);
    await subscriber.handler(questionEvent(20, 'task-hotel'));
    await subscriber.handler(questionEvent(21, 'task-india'));

    expect(await openRowCount(client)).toBe(2);
  });

  it('ignores events of other types', async () => {
    const [subscriber] = buildQuestionRaiseSubscribers(client);
    await subscriber.handler({
      id: 1,
      type: 'task.blocked',
      payload: { taskId: 'task-juliet', fixTaskId: null, failureSignature: 'sig', failingStep: 'verify' },
      ts: 1_000,
    });

    expect(await openRowCount(client)).toBe(0);
  });
});
