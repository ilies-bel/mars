/**
 * Question-raise Outbox Subscriber — behaviour tests.
 *
 * These tests drive the subscriber handler directly (without a running
 * dispatcher) so every assertion is synchronous and deterministic. The
 * file-backed SQLite client mirrors the real daemon setup: a single
 * `mars.db` that holds both the outbox `events` table and the
 * `action_queue_items` table, so the processedOnce dedup row and the
 * inbox write are co-located and covered by the same write transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  buildQuestionRaiseSubscribers,
  ensureQuestionRaiseSchema,
} from './question-raise.js';
import type { BusEvent } from '../../bus/events.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * File-backed libsql client with all tables required by the question-raise
 * subscriber. In-memory URLs are unsuitable because libsql's local backend
 * opens a fresh connection per transaction and would see empty tables.
 */
async function makeClient(dir: string): Promise<Client> {
  const client = createClient({ url: `file:${join(dir, 'mars.db')}` });

  // Outbox events table (the subscriber cursor lives here).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      type    TEXT    NOT NULL,
      payload TEXT    NOT NULL,
      ts      INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Action-queue inbox tables (the subscriber's side-effect destination).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS action_queue_items (
      id              TEXT    PRIMARY KEY,
      kind            TEXT    NOT NULL,
      category        TEXT    NOT NULL,
      priority        TEXT    NOT NULL,
      state           TEXT    NOT NULL DEFAULT 'open',
      title           TEXT    NOT NULL,
      body            TEXT    NOT NULL DEFAULT '',
      payload         TEXT    NOT NULL DEFAULT '{}',
      context         TEXT    NOT NULL DEFAULT '{}',
      raised_by       TEXT    NOT NULL,
      raised_at       TEXT    NOT NULL,
      resolved_at     TEXT,
      resolution      TEXT,
      resolution_note TEXT,
      root_cause      TEXT,
      fingerprint     TEXT,
      signature       TEXT,
      seen_count      INTEGER NOT NULL DEFAULT 1,
      last_seen_at    TEXT,
      resolved_by     TEXT,
      origin_task_id  TEXT
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS action_queue_history (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL,
      at         TEXT NOT NULL,
      from_state TEXT,
      to_state   TEXT NOT NULL,
      by         TEXT,
      note       TEXT
    )
  `);

  return client;
}

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
async function openRowCount(client: Client): Promise<number> {
  const r = await client.execute(
    `SELECT COUNT(*) AS n FROM action_queue_items WHERE state = 'open'`,
  );
  return Number((r.rows[0] as unknown as { n: number | bigint }).n);
}

/** Return the open action-queue row for `taskId`, or null if absent. */
async function openRowForTask(
  client: Client,
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
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-question-raise-test-'));
    client = await makeClient(tmpDir);
    await ensureQuestionRaiseSchema(client);
  });

  afterEach(() => {
    client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // Each coder question event raises exactly one inbox row.

  it('raises exactly one inbox row when a task.question event is processed', async () => {
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

  it('replaying the same event id raises zero additional inbox rows', async () => {
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
  // A daemon restart between the state-write and the inbox raise still
  // results in exactly one row appearing on next start.

  it('after a restart with no prior processing, the first delivery creates exactly one row', async () => {
    // Simulates: event written to outbox, daemon crashes before subscriber
    // processes it (processedOnce dedup table is empty). On restart a fresh
    // subscriber instance processes the event and the inbox row appears.
    const event = questionEvent(99, 'task-echo');

    // Fresh subscriber — no dedup row in DB yet
    const [subscriber] = buildQuestionRaiseSubscribers(client);
    await subscriber.handler(event);

    expect(await openRowCount(client)).toBe(1);
  });

  it('processedOnce dedup persists across subscriber instances, preventing a double-raise on restart', async () => {
    // Simulates: first subscriber instance processes the event successfully
    // (processedOnce commits dedup row + inbox row) but the cursor advance
    // fails before the daemon dies. On restart a second subscriber instance
    // sees the same event (cursor still behind). The persisted dedup row
    // must prevent a second inbox raise.
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

  it('different tasks each get their own inbox row', async () => {
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
