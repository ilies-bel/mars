/**
 * Action-queue-raiser Outbox Subscribers — behaviour tests.
 *
 * These tests drive the subscriber handlers directly (without a running
 * dispatcher) so every assertion is synchronous and deterministic.
 *
 * The test setup mirrors the pattern used in action-queue.test.ts: a real
 * git repo is created in a temp directory, MARS_REPO is set to point to it,
 * and vi.resetModules() ensures stateClient() (used by raiseActionQueueItem)
 * opens the same `mars.db` file as the test client. All writes — the
 * processedOnce dedup row and the action_queue_items row — land in the same
 * file, so assertions on the test client see the rows raised by the handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import type { BusEvent } from '../../bus/events.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal git repo in a temp directory so resolveContext() (used by
 * stateClient()) can locate the repo root. Sets MARS_REPO so the repo is
 * found without git, then resets all module caches so stateClient() and
 * resolveOriginIdForTask() open the fresh test DB.
 */
function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-action-queue-raisers-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.mars'), { recursive: true });
  return repo;
}

/**
 * File-backed libsql client pointing at the same path stateClient() would
 * use for the given repo root. Includes all tables the action-queue-raiser subscriber
 * writes to or reads from.
 */
async function makeClient(repo: string): Promise<Client> {
  const dbPath = resolve(repo, '.mars', 'mars.db');
  const client = createClient({ url: `file:${dbPath}` });

  // Action-queue tables (written by raiseActionQueueItem).
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

  // Minimal tasks table for origin-resolution tests.
  // resolveOriginIdForTask queries: SELECT origin_id, id FROM tasks WHERE id = ?
  await client.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      prompt     TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      origin_id  TEXT
    )
  `);

  return client;
}

/** Construct a minimal `task.blocked` BusEvent. */
function blockedEvent(
  eventId: number,
  taskId: string,
  opts?: { failureSignature?: string; failingStep?: string; originId?: string; fixTaskId?: string | null },
): BusEvent {
  return {
    id: eventId,
    type: 'task.blocked',
    payload: {
      taskId,
      fixTaskId: opts?.fixTaskId ?? null,
      failureSignature: opts?.failureSignature ?? `sig-${taskId}`,
      failingStep: opts?.failingStep ?? 'verify',
      ...(opts?.originId !== undefined ? { originId: opts.originId } : {}),
    },
    ts: 1_000,
  };
}

/** Construct a minimal `task.terminal` BusEvent. */
function terminalEvent(
  eventId: number,
  taskId: string,
  reason: 'done' | 'dropped' | 'failed' | 'purged',
): BusEvent {
  return {
    id: eventId,
    type: 'task.terminal',
    payload: { taskId, reason },
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

describe('action-queue-raiser:task.blocked subscriber', () => {
  let tmpDir: string;
  let client: Client;
  let buildActionQueueRaiserSubscribers: typeof import('./action-queue-raisers.js').buildActionQueueRaiserSubscribers;
  let ensureActionQueueRaiserSchema: typeof import('./action-queue-raisers.js').ensureActionQueueRaiserSchema;

  beforeEach(async () => {
    tmpDir = setupRepo();

    // Set MARS_REPO before resetting modules so stateClient() and
    // resolveOriginIdForTask() both open the test repo's mars.db on first use.
    process.env.MARS_REPO = tmpDir;

    // Reset all module-level singletons (stateClient, queueClient, context
    // cache, action-queue initialised flag, etc.) so each test gets a clean
    // module environment pointed at the fresh tmpDir.
    vi.resetModules();

    // Create the test DB at the same path stateClient() will use.
    client = await makeClient(tmpDir);

    // Dynamic import AFTER resetModules so we get the fresh module instances.
    const mod = await import('./action-queue-raisers.js');
    buildActionQueueRaiserSubscribers = mod.buildActionQueueRaiserSubscribers;
    ensureActionQueueRaiserSchema = mod.ensureActionQueueRaiserSchema;

    // Create the subscriber_processed_events dedup table on the shared client.
    await ensureActionQueueRaiserSchema(client);
  });

  afterEach(() => {
    client.close();
    delete process.env.MARS_REPO;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // Each triggering state-change event raises exactly one action-queue item.

  it('raises exactly one action-queue item when a task.blocked event is processed', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(1, 'task-alpha'));

    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'task-alpha');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('failed');
    expect(row!.originTaskId).toBe('task-alpha');
  });

  it('records kind=failed, category=orchestrator, priority=high on the new row', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
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

  it('replaying the same event id raises zero additional action-queue rows', async () => {
    const event = blockedEvent(42, 'task-charlie');
    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    // First delivery
    await subscriber.handler(event);
    expect(await openRowCount(client)).toBe(1);

    // Replay — same event id, same subscriber
    await subscriber.handler(event);

    // processedOnce dedup row prevents re-entry: still exactly one row
    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'task-charlie');
    // seen_count must NOT have changed — processedOnce blocked re-entry
    // before raiseActionQueueItem even ran.
    expect(row!.seenCount).toBe(1);
  });

  // ── Acceptance criterion 3 ─────────────────────────────────────────────
  // A daemon restart between the state-write and the action-queue raise still
  // results in exactly one row appearing on next start.

  it('after a restart with no prior processing, the first delivery creates exactly one row', async () => {
    // Simulates: event written to outbox, daemon crashes before subscriber
    // processes it (processedOnce dedup table is empty). On restart a fresh
    // subscriber instance processes the event and the action-queue item appears.
    const event = blockedEvent(99, 'task-delta');

    // Fresh subscriber — no dedup row in DB yet
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(event);

    expect(await openRowCount(client)).toBe(1);
  });

  it('processedOnce dedup persists across subscriber instances, preventing a double-raise on restart', async () => {
    // Simulates: first subscriber instance processes the event successfully
    // (processedOnce commits dedup row) but the cursor advance fails before
    // the daemon dies. On restart a second subscriber instance sees the same
    // event (cursor still behind). The persisted dedup row must prevent a
    // second raise.
    const event = blockedEvent(7, 'task-echo');

    const [sub1] = buildActionQueueRaiserSubscribers(client);
    await sub1.handler(event);
    expect(await openRowCount(client)).toBe(1);

    // Restart: new subscriber instance, same file-backed DB (dedup row persists)
    const [sub2] = buildActionQueueRaiserSubscribers(client);
    await sub2.handler(event);

    // Dedup row in DB prevented re-raise
    expect(await openRowCount(client)).toBe(1);
    expect((await openRowForTask(client, 'task-echo'))!.seenCount).toBe(1);
  });

  // ── Origin-fingerprint dedup ───────────────────────────────────────────
  // Multiple task.blocked events for the same task collapse into one row.

  it('two distinct task.blocked events for the same task produce one open row (origin-fingerprint dedup)', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    // Different event ids → processedOnce allows both, but origin-fingerprint
    // dedup inside raiseActionQueueItem collapses them into one row.
    await subscriber.handler(blockedEvent(10, 'task-foxtrot'));
    await subscriber.handler(blockedEvent(11, 'task-foxtrot'));

    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'task-foxtrot');
    // Second event bumped seen_count
    expect(row!.seenCount).toBe(2);
  });

  it('different tasks each get their own action-queue row', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(20, 'task-golf'));
    await subscriber.handler(blockedEvent(21, 'task-hotel'));

    expect(await openRowCount(client)).toBe(2);
  });

  // ── Arc-origin threading (finding #6 of lineage audit) ────────────────
  // A blocked slice (id != originId) must produce a row keyed on the arc
  // origin so all slices of the same arc collapse onto a single action-queue item.

  it('a blocked slice (id != originId) yields a row fingerprinted on origin:<originId>, collapsing onto the arc', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    // First slice of the arc blocked — originId points to the arc root.
    await subscriber.handler(
      blockedEvent(50, 'slice-1', { originId: 'origin-india' }),
    );
    expect(await openRowCount(client)).toBe(1);

    const row1 = await openRowForTask(client, 'origin-india');
    expect(row1).not.toBeNull();
    expect(row1!.originTaskId).toBe('origin-india');
    expect(row1!.seenCount).toBe(1);

    // Second slice of the same arc blocked — different taskId, same originId.
    // Must collapse onto the existing row, not create a second one.
    await subscriber.handler(
      blockedEvent(51, 'slice-2', { originId: 'origin-india' }),
    );
    expect(await openRowCount(client)).toBe(1);

    const row2 = await openRowForTask(client, 'origin-india');
    expect(row2!.originTaskId).toBe('origin-india');
    expect(row2!.seenCount).toBe(2);
  });

  it('a blocked slice (id != originId) does NOT produce a row keyed on the slice id', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    await subscriber.handler(
      blockedEvent(60, 'slice-juliet', { originId: 'origin-juliet' }),
    );

    // No row should be keyed on the slice's own id.
    const rowForSlice = await openRowForTask(client, 'slice-juliet');
    expect(rowForSlice).toBeNull();

    // The row must be keyed on the arc origin instead.
    const rowForOrigin = await openRowForTask(client, 'origin-juliet');
    expect(rowForOrigin).not.toBeNull();
    expect(rowForOrigin!.originTaskId).toBe('origin-juliet');
  });

  // ── DB-based arc-origin resolution (ADR-0051 violation fix) ───────────
  // When originId is absent from the event payload but the task row in the DB
  // carries an origin_id, raiseActionQueueItem must resolve through the DB so
  // the action-queue item is keyed on the true arc root — not the raw (fix/descendant)
  // task id.

  it('a raiser called with a fix/descendant taskId whose task row has origin_id resolves to the arc origin', async () => {
    // Insert a task row: fix-task is a descendant of arc-root.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES ('fix-task-kilo', '', 'blocked', '', '', 'arc-root-kilo')`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    // Fire event with the fix task id; no originId in the payload (simulates
    // older events where the field was not yet threaded in).
    await subscriber.handler(blockedEvent(100, 'fix-task-kilo'));

    expect(await openRowCount(client)).toBe(1);

    // Row must be keyed on the arc root, NOT on the fix task id.
    const rowForArc = await openRowForTask(client, 'arc-root-kilo');
    expect(rowForArc).not.toBeNull();
    expect(rowForArc!.originTaskId).toBe('arc-root-kilo');

    const rowForFix = await openRowForTask(client, 'fix-task-kilo');
    expect(rowForFix).toBeNull();
  });

  it('two events for different fix tasks from the same arc collapse onto one row keyed on the arc origin', async () => {
    // Both fix tasks share the same arc root.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES ('fix-lima-1', '', 'blocked', '', '', 'arc-root-lima'),
                   ('fix-lima-2', '', 'blocked', '', '', 'arc-root-lima')`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    await subscriber.handler(blockedEvent(200, 'fix-lima-1'));
    await subscriber.handler(blockedEvent(201, 'fix-lima-2'));

    // Both events resolve to the same arc root → one row, seenCount=2.
    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'arc-root-lima');
    expect(row).not.toBeNull();
    expect(row!.originTaskId).toBe('arc-root-lima');
    expect(row!.seenCount).toBe(2);
  });

  // ── Fix-task invariant: no alert while recovery is in flight ──────────
  // task.blocked events whose payload carries a non-null fixTaskId pointing
  // at an outstanding (not-yet-terminal) fix task must NOT raise a row.

  it('task.blocked with an outstanding fix task (queued) raises no action-queue row', async () => {
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('fix-outstanding-1', '', 'queued', '', '')`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(500, 'origin-for-outstanding-1', { fixTaskId: 'fix-outstanding-1' }),
    );

    // Fix task is queued (outstanding) — no human action needed, no row.
    expect(await openRowCount(client)).toBe(0);
  });

  it('task.blocked with an outstanding fix task (running) raises no action-queue row', async () => {
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('fix-running-1', '', 'running', '', '')`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(501, 'origin-for-running-1', { fixTaskId: 'fix-running-1' }),
    );

    expect(await openRowCount(client)).toBe(0);
  });

  it('task.blocked with a terminal-failed fix task still raises an action-queue row', async () => {
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('fix-failed-1', '', 'failed', '', '')`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(502, 'origin-for-failed-1', { fixTaskId: 'fix-failed-1' }),
    );

    // Fix task itself failed — recovery exhausted — human action required.
    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'origin-for-failed-1');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('failed');
  });

  it('task.blocked with a fixTaskId absent from the DB still raises an action-queue row', async () => {
    // No task inserted for 'fix-absent'. Conservative: if we cannot confirm
    // recovery is in flight, raise so the operator can investigate.
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(503, 'origin-for-absent', { fixTaskId: 'fix-absent' }),
    );

    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'origin-for-absent');
    expect(row).not.toBeNull();
  });

  it('task.blocked with null fixTaskId always raises (existing behaviour)', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(504, 'origin-null-fix'));

    expect(await openRowCount(client)).toBe(1);
    const row = await openRowForTask(client, 'origin-null-fix');
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Fix-task-done: auto-resolve stale 'failed' rows
// ---------------------------------------------------------------------------

describe('action-queue-raiser:fix-task-done subscriber', () => {
  let tmpDir: string;
  let client: Client;
  let buildActionQueueRaiserSubscribers: typeof import('./action-queue-raisers.js').buildActionQueueRaiserSubscribers;
  let ensureActionQueueRaiserSchema: typeof import('./action-queue-raisers.js').ensureActionQueueRaiserSchema;

  beforeEach(async () => {
    tmpDir = setupRepo();
    process.env.MARS_REPO = tmpDir;
    vi.resetModules();
    client = await makeClient(tmpDir);

    const mod = await import('./action-queue-raisers.js');
    buildActionQueueRaiserSubscribers = mod.buildActionQueueRaiserSubscribers;
    ensureActionQueueRaiserSchema = mod.ensureActionQueueRaiserSchema;

    await ensureActionQueueRaiserSchema(client);
  });

  afterEach(() => {
    client.close();
    delete process.env.MARS_REPO;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Insert a pre-existing open 'failed' row keyed on `originId`. */
  async function insertOpenFailedRow(c: Client, id: string, originId: string): Promise<void> {
    await c.execute({
      sql: `INSERT INTO action_queue_items
              (id, kind, category, priority, state, title, body, raised_by, raised_at, origin_task_id)
            VALUES (?, 'failed', 'orchestrator', 'high', 'open', 'pre-existing failure', '',
                    'test', datetime('now'), ?)`,
      args: [id, originId],
    });
  }

  it('task.terminal done for a fix task resolves the open failed row for the arc origin', async () => {
    const originId = 'arc-fix-done-1';
    const fixTaskId = 'fix-done-task-1';

    // Insert the fix task with origin_id pointing at the arc origin.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES (?, '', 'done', '', '', ?)`,
      args: [fixTaskId, originId],
    });

    // Pre-existing open 'failed' row that was raised before the fix task ran.
    await insertOpenFailedRow(client, 'aq-stale-1', originId);
    expect(await openRowCount(client)).toBe(1);

    // Deliver task.terminal done to all subscribers (each ignores events of wrong type).
    const subscribers = buildActionQueueRaiserSubscribers(client);
    for (const sub of subscribers) {
      await sub.handler(terminalEvent(600, fixTaskId, 'done'));
    }

    // Stale row must be resolved — recovery succeeded, no human action needed.
    expect(await openRowCount(client)).toBe(0);
    const r = await client.execute(
      `SELECT state FROM action_queue_items WHERE id = 'aq-stale-1'`,
    );
    expect((r.rows[0] as unknown as { state: string }).state).toBe('resolved');
  });

  it('task.terminal done for a non-fix task (no origin_id) does not modify action-queue rows', async () => {
    const normalTaskId = 'normal-task-done-1';

    // Normal task — no origin_id.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, '', 'done', '', '')`,
      args: [normalTaskId],
    });

    // Unrelated open row.
    await insertOpenFailedRow(client, 'aq-unrelated-1', 'some-other-origin');
    expect(await openRowCount(client)).toBe(1);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    for (const sub of subscribers) {
      await sub.handler(terminalEvent(601, normalTaskId, 'done'));
    }

    // Unrelated row must be untouched.
    expect(await openRowCount(client)).toBe(1);
  });

  it('task.terminal done is idempotent — replaying the same event does not re-resolve', async () => {
    const originId = 'arc-fix-done-2';
    const fixTaskId = 'fix-done-task-2';

    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES (?, '', 'done', '', '', ?)`,
      args: [fixTaskId, originId],
    });
    await insertOpenFailedRow(client, 'aq-stale-2', originId);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    // First delivery.
    for (const sub of subscribers) {
      await sub.handler(terminalEvent(602, fixTaskId, 'done'));
    }
    expect(await openRowCount(client)).toBe(0);

    // Replay — same eventId. Must not throw even though row is already resolved.
    for (const sub of subscribers) {
      await sub.handler(terminalEvent(602, fixTaskId, 'done'));
    }
    expect(await openRowCount(client)).toBe(0);
  });

  it('task.terminal failed for a fix task does not resolve the open row', async () => {
    const originId = 'arc-fix-failed-1';
    const fixTaskId = 'fix-failed-task-1';

    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES (?, '', 'failed', '', '', ?)`,
      args: [fixTaskId, originId],
    });
    await insertOpenFailedRow(client, 'aq-stale-3', originId);
    expect(await openRowCount(client)).toBe(1);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    for (const sub of subscribers) {
      // Reason is 'failed', not 'done' — subscriber must be a no-op.
      await sub.handler(terminalEvent(603, fixTaskId, 'failed'));
    }

    // Row must remain open — the fix task failed.
    expect(await openRowCount(client)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// API-outage coalescing
// ---------------------------------------------------------------------------

describe('api-outage coalescing — circuit-breaker-open failures', () => {
  let tmpDir: string;
  let client: Client;
  let buildActionQueueRaiserSubscribers: typeof import('./action-queue-raisers.js').buildActionQueueRaiserSubscribers;
  let ensureActionQueueRaiserSchema: typeof import('./action-queue-raisers.js').ensureActionQueueRaiserSchema;
  let resolveOutageRowOnBreakerClose: typeof import('./action-queue-raisers.js').resolveOutageRowOnBreakerClose;
  let apiCircuitBreaker: typeof import('../../core/lib/api-circuit-breaker.js').apiCircuitBreaker;

  beforeEach(async () => {
    tmpDir = setupRepo();
    process.env.MARS_REPO = tmpDir;
    vi.resetModules();
    client = await makeClient(tmpDir);

    // Import the raisers module first — this pulls in api-circuit-breaker as a
    // dependency and registers it in the module cache. The subsequent import of
    // api-circuit-breaker returns the SAME cached module instance that the
    // raisers module is using, so our test manipulations affect the right singleton.
    const mod = await import('./action-queue-raisers.js');
    buildActionQueueRaiserSubscribers = mod.buildActionQueueRaiserSubscribers;
    ensureActionQueueRaiserSchema = mod.ensureActionQueueRaiserSchema;
    resolveOutageRowOnBreakerClose = mod.resolveOutageRowOnBreakerClose;

    const breakerMod = await import('../../core/lib/api-circuit-breaker.js');
    apiCircuitBreaker = breakerMod.apiCircuitBreaker;

    await ensureActionQueueRaiserSchema(client);
  });

  afterEach(() => {
    // Ensure the breaker is closed after each test so module state does not
    // bleed (even though vi.resetModules() would reset it on the next cycle).
    apiCircuitBreaker.close();
    client.close();
    delete process.env.MARS_REPO;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Criterion 1 ────────────────────────────────────────────────────────
  // Two environmental failures in the same window produce one outage row with
  // count=2; no per-task 'failed' row is created.

  it('two environmental failures in the same window produce one api-outage row with count=2', async () => {
    // Deterministic timestamp so the signature is predictable.
    const openedAt = 1_700_000_000_000;
    apiCircuitBreaker.open('ECONNREFUSED', openedAt);

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(300, 'task-outage-1'));
    await subscriber.handler(blockedEvent(301, 'task-outage-2'));

    // Exactly one open row total — the api-outage coalescing row.
    expect(await openRowCount(client)).toBe(1);

    const r = await client.execute(
      `SELECT kind, seen_count FROM action_queue_items WHERE state = 'open' LIMIT 1`,
    );
    const row = r.rows[0] as unknown as { kind: string; seen_count: number | bigint };
    expect(row.kind).toBe('api-outage');
    expect(Number(row.seen_count)).toBe(2);
  });

  // ── Criterion 2 ────────────────────────────────────────────────────────
  // A subsequent non-environmental failure (breaker closed) produces its own
  // per-task 'failed' row and does not attach to the api-outage row.

  it('non-environmental failure after breaker closes produces its own per-task row', async () => {
    const openedAt = 1_700_000_001_000;
    apiCircuitBreaker.open('ECONNREFUSED', openedAt);

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    // Environmental failures while breaker is open.
    await subscriber.handler(blockedEvent(310, 'task-env-a'));
    await subscriber.handler(blockedEvent(311, 'task-env-b'));

    // Close the breaker — subsequent failures are non-environmental.
    apiCircuitBreaker.close();

    await subscriber.handler(blockedEvent(312, 'task-normal-c'));

    // Two open rows: one api-outage (count=2) + one per-task 'failed'.
    expect(await openRowCount(client)).toBe(2);

    const outage = await client.execute(
      `SELECT kind, seen_count FROM action_queue_items WHERE kind = 'api-outage' AND state = 'open'`,
    );
    expect(outage.rows).toHaveLength(1);
    expect(Number((outage.rows[0] as unknown as { seen_count: number | bigint }).seen_count)).toBe(2);

    const failed = await client.execute(
      `SELECT kind FROM action_queue_items WHERE kind = 'failed' AND state = 'open'`,
    );
    expect(failed.rows).toHaveLength(1);
  });

  // ── Criterion 3 ────────────────────────────────────────────────────────
  // Breaker close + task drain resolves the outage row.

  it('resolves the outage row once the breaker is closed and all affected tasks are drained', async () => {
    const openedAt = 1_700_000_002_000;
    apiCircuitBreaker.open('ECONNREFUSED', openedAt);

    // Insert the affected tasks as 'failed' so they simulate tasks that were
    // mid-flight when the breaker tripped.
    await client.execute({
      sql: `INSERT INTO tasks (id, status) VALUES ('task-drain-x', 'failed'), ('task-drain-y', 'failed')`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(320, 'task-drain-x'));
    await subscriber.handler(blockedEvent(321, 'task-drain-y'));

    // Outage row is open with count=2.
    expect(await openRowCount(client)).toBe(1);

    // Tasks are still 'failed' — resolution should be deferred.
    await resolveOutageRowOnBreakerClose(openedAt);
    expect(await openRowCount(client)).toBe(1); // not yet resolved

    // Simulate tasks being requeued after the outage clears.
    await client.execute({
      sql: `UPDATE tasks SET status = 'queued' WHERE id IN ('task-drain-x', 'task-drain-y')`,
    });

    // Now all tasks are drained — outage row should be resolved.
    await resolveOutageRowOnBreakerClose(openedAt);
    expect(await openRowCount(client)).toBe(0);

    const r = await client.execute(
      `SELECT state FROM action_queue_items WHERE kind = 'api-outage' LIMIT 1`,
    );
    expect((r.rows[0] as unknown as { state: string }).state).toBe('resolved');
  });
});
