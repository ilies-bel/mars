/**
 * Inbox-raiser Outbox Subscribers — behaviour tests.
 *
 * These tests drive the subscriber handlers directly (without a running
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
  buildInboxRaiserSubscribers,
  ensureInboxRaiserSchema,
} from './inbox-raisers.js';
import type { BusEvent } from '../../bus/events.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * File-backed libsql client with all tables required by the inbox-raiser
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

/** Construct a minimal `task.blocked` BusEvent. */
function blockedEvent(
  eventId: number,
  taskId: string,
  opts?: { failureSignature?: string; failingStep?: string },
): BusEvent {
  return {
    id: eventId,
    type: 'task.blocked',
    payload: {
      taskId,
      fixTaskId: null,
      failureSignature: opts?.failureSignature ?? `sig-${taskId}`,
      failingStep: opts?.failingStep ?? 'verify',
    },
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

describe('inbox-raiser:task.blocked subscriber', () => {
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-inbox-raisers-test-'));
    client = await makeClient(tmpDir);
    await ensureInboxRaiserSchema(client);
  });

  afterEach(() => {
    client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // Each triggering state-change event raises exactly one inbox row.

  it('raises exactly one inbox row when a task.blocked event is processed', async () => {
    const [subscriber] = buildInboxRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(1, 'task-alpha'));

    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'task-alpha');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('failed');
    expect(row!.originTaskId).toBe('task-alpha');
  });

  it('records kind=failed, category=orchestrator, priority=high on the new row', async () => {
    const [subscriber] = buildInboxRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(2, 'task-bravo'));

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
    expect(row.kind).toBe('failed');
    expect(row.category).toBe('orchestrator');
    expect(row.priority).toBe('high');
  });

  // ── Acceptance criterion 2 ─────────────────────────────────────────────
  // Replaying the same triggering event raises zero additional rows.

  it('replaying the same event id raises zero additional inbox rows', async () => {
    const event = blockedEvent(42, 'task-charlie');
    const [subscriber] = buildInboxRaiserSubscribers(client);

    // First delivery
    await subscriber.handler(event);
    expect(await openRowCount(client)).toBe(1);

    // Replay — same event id, same subscriber
    await subscriber.handler(event);

    // processedOnce dedup row prevents re-entry: still exactly one row
    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'task-charlie');
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
    const event = blockedEvent(99, 'task-delta');

    // Fresh subscriber — no dedup row in DB yet
    const [subscriber] = buildInboxRaiserSubscribers(client);
    await subscriber.handler(event);

    expect(await openRowCount(client)).toBe(1);
  });

  it('processedOnce dedup persists across subscriber instances, preventing a double-raise on restart', async () => {
    // Simulates: first subscriber instance processes the event successfully
    // (processedOnce commits dedup row + inbox row) but the cursor advance
    // fails before the daemon dies. On restart a second subscriber instance
    // sees the same event (cursor still behind). The persisted dedup row
    // must prevent a second inbox raise.
    const event = blockedEvent(7, 'task-echo');

    const [sub1] = buildInboxRaiserSubscribers(client);
    await sub1.handler(event);
    expect(await openRowCount(client)).toBe(1);

    // Restart: new subscriber instance, same file-backed DB (dedup row persists)
    const [sub2] = buildInboxRaiserSubscribers(client);
    await sub2.handler(event);

    // Dedup row in DB prevented re-raise
    expect(await openRowCount(client)).toBe(1);
    expect((await openRowForTask(client, 'task-echo'))!.seenCount).toBe(1);
  });

  // ── Origin-fingerprint dedup ───────────────────────────────────────────
  // Multiple task.blocked events for the same task collapse into one row.

  it('two distinct task.blocked events for the same task produce one open row (origin-fingerprint dedup)', async () => {
    const [subscriber] = buildInboxRaiserSubscribers(client);

    // Different event ids → processedOnce allows both, but origin-fingerprint
    // dedup inside the sideEffect collapses them into one row.
    await subscriber.handler(blockedEvent(10, 'task-foxtrot'));
    await subscriber.handler(blockedEvent(11, 'task-foxtrot'));

    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'task-foxtrot');
    // Second event bumped seen_count
    expect(row!.seenCount).toBe(2);
  });

  it('different tasks each get their own inbox row', async () => {
    const [subscriber] = buildInboxRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(20, 'task-golf'));
    await subscriber.handler(blockedEvent(21, 'task-hotel'));

    expect(await openRowCount(client)).toBe(2);
  });
});
