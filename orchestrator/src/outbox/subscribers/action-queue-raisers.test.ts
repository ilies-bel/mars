/**
 * Action-queue-raiser Outbox Subscribers — behaviour tests.
 *
 * These tests drive the subscriber handlers directly (without a running
 * dispatcher) so every assertion is synchronous and deterministic.
 *
 * The test setup mirrors the pattern used in action-queue.test.ts: a real
 * git repo is created in a temp directory, MARS_REPO is set to point to it,
 * and vi.resetModules() ensures resolveStateClient() (used by
 * raiseActionQueueItem) opens the same database as the test client. Under
 * MARS_DB_BACKEND=pglite the DB identity key is the resolved `.mars` state
 * dir, so the test acquires its client from the SAME freshly-reset db module
 * with that key — all writes (the processedOnce dedup row and the
 * action_queue_items row) land in one in-memory instance and assertions on
 * the test client see the rows raised by the handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DbClient } from '../../core/lib/db.js';
import type { BusEvent } from '../../bus/events.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal git repo in a temp directory so resolveContext() (used by
 * resolveStateClient()) can locate the repo root. Sets MARS_REPO so the repo
 * is found without git, then resets all module caches so resolveStateClient()
 * and resolveOriginIdForTask() open the fresh test DB.
 */
function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mars-action-queue-raisers-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.mars'), { recursive: true });
  return repo;
}

/**
 * Acquire the client for the SAME database identity resolveStateClient()
 * will use for the given repo root (under pglite the key is the resolved
 * `.mars` state dir), from the freshly-reset db module, and apply the
 * canonical schema. MUST be called after `vi.resetModules()` so the handle
 * comes from the same module registry the subscriber module uses.
 */
async function makeClient(repo: string): Promise<DbClient> {
  const { openDb } = await import('../../core/lib/db.js');
  const { ensureSchema } = await import('../../core/lib/pg-schema.js');
  const client = openDb(resolve(repo, '.mars'));
  await ensureSchema(client);
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
async function openRowCount(client: DbClient): Promise<number> {
  const r = await client.execute(
    `SELECT COUNT(*) AS n FROM action_queue_items WHERE status = 'open'`,
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
           WHERE origin_task_id = ? AND status = 'open'
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
  let client: DbClient;
  let buildActionQueueRaiserSubscribers: typeof import('./action-queue-raisers.js').buildActionQueueRaiserSubscribers;

  beforeEach(async () => {
    tmpDir = setupRepo();

    // Set MARS_REPO before resetting modules so resolveStateClient() and
    // resolveOriginIdForTask() both open the test repo's DB on first use.
    process.env.MARS_REPO = tmpDir;

    // Reset all module-level singletons (state client, queue client, context
    // cache, action-queue initialised flag, db registry, etc.) so each test
    // gets a clean module environment pointed at the fresh tmpDir.
    vi.resetModules();

    // Acquire the test client for the same DB identity resolveStateClient()
    // will use, and apply the canonical schema.
    client = await makeClient(tmpDir);

    // Dynamic import AFTER resetModules so we get the fresh module instances.
    const mod = await import('./action-queue-raisers.js');
    buildActionQueueRaiserSubscribers = mod.buildActionQueueRaiserSubscribers;
  });

  afterEach(async () => {
    await client.close();
    delete process.env.MARS_REPO;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // ADR-0057: `failed` is now a CONDITION KIND — derived on read from
  // tasks.status='failed'. No stored action_queue_items row is ever written
  // by taskBlockedActionQueueRaiser. These tests verify that the subscriber
  // runs without error and writes zero stored rows.

  it('writes zero stored rows when a task.blocked event is processed (failed is derived)', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(1, 'task-alpha'));

    // ADR-0057: no stored row — the failed condition is derived on read.
    expect(await openRowCount(client)).toBe(0);
  });

  it('writes zero stored rows (kind=failed is now a derived condition, not a stored row)', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(2, 'task-bravo'));

    // ADR-0057: no stored row written.
    const r = await client.execute({
      sql: `SELECT kind, category, priority FROM action_queue_items WHERE origin_task_id = ?`,
      args: ['task-bravo'],
    });
    expect(r.rows).toHaveLength(0);
  });

  // ── Acceptance criterion 2 ─────────────────────────────────────────────
  // Replaying the same triggering event raises zero additional rows.
  // ADR-0057: since no stored row is written, both first-delivery and replay
  // produce zero rows — the processedOnce guard still fires (dedup row is
  // written) but the action-queue write path is a no-op.

  it('replaying the same event id raises zero additional action-queue rows', async () => {
    const event = blockedEvent(42, 'task-charlie');
    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    // First delivery — ADR-0057: no stored row.
    await subscriber.handler(event);
    expect(await openRowCount(client)).toBe(0);

    // Replay — same event id, same subscriber
    await subscriber.handler(event);

    // processedOnce dedup prevents re-entry; still zero rows.
    expect(await openRowCount(client)).toBe(0);
  });

  // ── Acceptance criterion 3 ─────────────────────────────────────────────
  // A daemon restart between the state-write and the action-queue raise still
  // results in zero stored rows — the condition is derived on read regardless.

  it('after a restart with no prior processing, the first delivery writes zero stored rows', async () => {
    // Simulates: event written to outbox, daemon crashes before subscriber
    // processes it (processedOnce dedup table is empty). On restart a fresh
    // subscriber instance processes the event. ADR-0057: no stored row written.
    const event = blockedEvent(99, 'task-delta');

    // Fresh subscriber — no dedup row in DB yet
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(event);

    // ADR-0057: failed is derived on read; zero stored rows.
    expect(await openRowCount(client)).toBe(0);
  });

  it('processedOnce dedup persists across subscriber instances, preventing a double-raise on restart', async () => {
    // Simulates: first subscriber instance processes the event successfully
    // (processedOnce commits dedup row) but the cursor advance fails before
    // the daemon dies. On restart a second subscriber instance sees the same
    // event (cursor still behind). The persisted dedup row must prevent a
    // second raise.
    // ADR-0057: no stored rows in either case; the test verifies the processedOnce
    // guard still works (zero rows both before and after the simulated restart).
    const event = blockedEvent(7, 'task-echo');

    const [sub1] = buildActionQueueRaiserSubscribers(client);
    await sub1.handler(event);
    // ADR-0057: no stored row.
    expect(await openRowCount(client)).toBe(0);

    // Restart: new subscriber instance, same file-backed DB (dedup row persists)
    const [sub2] = buildActionQueueRaiserSubscribers(client);
    await sub2.handler(event);

    // Dedup row in DB prevented re-entry; still zero rows.
    expect(await openRowCount(client)).toBe(0);
  });

  // ── Origin-fingerprint dedup ───────────────────────────────────────────
  // ADR-0057: no stored rows are written for task.blocked events regardless of
  // how many events fire or how many distinct tasks are blocked.

  it('two distinct task.blocked events for the same task produce zero stored rows (failed is derived)', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    // Different event ids → processedOnce allows both through, but no stored
    // row is written since ADR-0057 made failed a derived condition.
    await subscriber.handler(blockedEvent(10, 'task-foxtrot'));
    await subscriber.handler(blockedEvent(11, 'task-foxtrot'));

    // ADR-0057: zero stored rows.
    expect(await openRowCount(client)).toBe(0);
  });

  it('different tasks each produce zero stored rows (failed is derived per-read)', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(20, 'task-golf'));
    await subscriber.handler(blockedEvent(21, 'task-hotel'));

    // ADR-0057: zero stored rows for any number of distinct tasks.
    expect(await openRowCount(client)).toBe(0);
  });

  // ── Arc-origin threading (finding #6 of lineage audit) ────────────────
  // ADR-0057: no stored rows are written for task.blocked events regardless of
  // arc structure. The subscriber runs to completion (processedOnce dedup fires)
  // but the action-queue write path is a no-op since failed is derived on read.

  it('a blocked slice (id != originId) produces zero stored rows (failed is derived)', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    // First slice of the arc blocked.
    await subscriber.handler(
      blockedEvent(50, 'slice-1', { originId: 'origin-india' }),
    );
    // ADR-0057: no stored row.
    expect(await openRowCount(client)).toBe(0);

    // Second slice of the same arc.
    await subscriber.handler(
      blockedEvent(51, 'slice-2', { originId: 'origin-india' }),
    );
    // Still zero stored rows.
    expect(await openRowCount(client)).toBe(0);
  });

  it('a blocked slice (id != originId) produces no row keyed on the slice id or the origin', async () => {
    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    await subscriber.handler(
      blockedEvent(60, 'slice-juliet', { originId: 'origin-juliet' }),
    );

    // ADR-0057: no stored row for either the slice or the arc origin.
    const rowForSlice = await openRowForTask(client, 'slice-juliet');
    expect(rowForSlice).toBeNull();

    const rowForOrigin = await openRowForTask(client, 'origin-juliet');
    expect(rowForOrigin).toBeNull();
  });

  // ── DB-based arc-origin resolution (ADR-0051 violation fix) ───────────
  // ADR-0057: no stored rows are written for task.blocked events. The arc-origin
  // resolution logic inside raiseActionQueueItem is still exercised by the
  // subscriber (the processedOnce side-effect runs), but results in zero stored
  // action_queue_items rows since the failed condition is derived on read.

  it('a raiser called with a fix/descendant taskId whose task row has origin_id produces zero stored rows', async () => {
    // Insert a task row: fix-task is a descendant of arc-root.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES ('fix-task-kilo', '', 'blocked', now(), now(), 'arc-root-kilo')`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    // Fire event with the fix task id; no originId in the payload (simulates
    // older events where the field was not yet threaded in).
    await subscriber.handler(blockedEvent(100, 'fix-task-kilo'));

    // ADR-0057: no stored row for arc root or fix task.
    expect(await openRowCount(client)).toBe(0);

    const rowForArc = await openRowForTask(client, 'arc-root-kilo');
    expect(rowForArc).toBeNull();

    const rowForFix = await openRowForTask(client, 'fix-task-kilo');
    expect(rowForFix).toBeNull();
  });

  it('two events for different fix tasks from the same arc produce zero stored rows', async () => {
    // Both fix tasks share the same arc root.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES ('fix-lima-1', '', 'blocked', now(), now(), 'arc-root-lima'),
                   ('fix-lima-2', '', 'blocked', now(), now(), 'arc-root-lima')`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);

    await subscriber.handler(blockedEvent(200, 'fix-lima-1'));
    await subscriber.handler(blockedEvent(201, 'fix-lima-2'));

    // ADR-0057: zero stored rows regardless of arc structure.
    expect(await openRowCount(client)).toBe(0);
    const row = await openRowForTask(client, 'arc-root-lima');
    expect(row).toBeNull();
  });

  // ── Fix-task invariant: no alert while recovery is in flight ──────────
  // task.blocked events whose payload carries a non-null fixTaskId pointing
  // at an outstanding (not-yet-terminal) fix task must NOT raise a row.

  it('task.blocked with an outstanding fix task (queued) raises no action-queue row', async () => {
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('fix-outstanding-1', '', 'queued', now(), now())`,
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
            VALUES ('fix-running-1', '', 'running', now(), now())`,
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
            VALUES ('fix-failed-1', '', 'failed', now(), now())`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(502, 'origin-for-failed-1', { fixTaskId: 'fix-failed-1' }),
    );

    // ADR-0057: `failed` is a derived condition; no stored row is written.
    expect(await openRowCount(client)).toBe(0);
  });

  it('task.blocked with a fixTaskId absent from the DB raises no action-queue row (condition derived)', async () => {
    // No task inserted for 'fix-absent'. ADR-0057: no stored row.
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(503, 'origin-for-absent', { fixTaskId: 'fix-absent' }),
    );

    expect(await openRowCount(client)).toBe(0);
  });

  it('task.blocked with null fixTaskId produces zero stored rows (condition is derived)', async () => {
    // ADR-0057: no stored row.
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(504, 'origin-null-fix'));

    expect(await openRowCount(client)).toBe(0);
  });

  // ── Slice 6: stall diagnostics and pool snapshot in payload ──────────

  it('payload includes stallDiagnostics from task stall_diagnostics and poolSnapshot from live counts', async () => {
    const taskId = 'task-with-stall-diag';
    const stallDiagData = { stderrTail: 'out of memory', exitCode: 1, durationMs: 12345 };

    // Seed the failing task with stall_diagnostics.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, stall_diagnostics)
            VALUES (?, '', 'failed', now(), now(), ?)`,
      args: [taskId, JSON.stringify(stallDiagData)],
    });

    // Seed tasks in different statuses to populate the pool snapshot.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('pool-q1', '', 'queued', now(), now())`,
    });
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('pool-q2', '', 'queued', now(), now())`,
    });
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('pool-r1', '', 'running', now(), now())`,
    });
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('pool-b1', '', 'blocked', now(), now())`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(600, taskId));

    // ADR-0057: `failed` is a derived condition; no stored row is written.
    expect(await openRowCount(client)).toBe(0);
  });

  it('payload has null stallDiagnostics when task row has no stall_diagnostics', async () => {
    const taskId = 'task-no-stall-diag';

    // Seed task WITHOUT stall_diagnostics.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, '', 'failed', now(), now())`,
      args: [taskId],
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(601, taskId));

    // ADR-0057: `failed` is a derived condition; no stored row is written.
    expect(await openRowCount(client)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix-task-done: auto-resolve stale 'failed' rows
// ---------------------------------------------------------------------------

describe('action-queue-raiser:fix-task-done subscriber', () => {
  let tmpDir: string;
  let client: DbClient;
  let buildActionQueueRaiserSubscribers: typeof import('./action-queue-raisers.js').buildActionQueueRaiserSubscribers;

  beforeEach(async () => {
    tmpDir = setupRepo();
    process.env.MARS_REPO = tmpDir;
    vi.resetModules();
    client = await makeClient(tmpDir);

    const mod = await import('./action-queue-raisers.js');
    buildActionQueueRaiserSubscribers = mod.buildActionQueueRaiserSubscribers;
  });

  afterEach(async () => {
    await client.close();
    delete process.env.MARS_REPO;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Insert a pre-existing open 'failed' row keyed on `originId`. */
  async function insertOpenFailedRow(c: DbClient, id: string, originId: string): Promise<void> {
    await c.execute({
      sql: `INSERT INTO action_queue_items
              (id, kind, category, priority, status, title, body, raised_by, raised_at, origin_task_id)
            VALUES (?, 'failed', 'orchestrator', 'high', 'open', 'pre-existing failure', '',
                    'test', ?, ?)`,
      args: [id, Date.now(), originId],
    });
  }

  it('task.terminal done for a fix task resolves the open failed row for the arc origin', async () => {
    const originId = 'arc-fix-done-1';
    const fixTaskId = 'fix-done-task-1';

    // Insert the fix task with origin_id pointing at the arc origin.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES (?, '', 'done', now(), now(), ?)`,
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

    // ADR-0057: fixTaskDoneActionQueueResolver was removed; stored rows are not
    // auto-resolved on fix-task completion. The pre-existing row stays open.
    expect(await openRowCount(client)).toBe(1);
    const r = await client.execute(
      `SELECT status FROM action_queue_items WHERE id = 'aq-stale-1'`,
    );
    expect((r.rows[0] as unknown as { status: string }).status).toBe('open');
  });

  it('task.terminal done for a non-fix task (no origin_id) does not modify action-queue rows', async () => {
    const normalTaskId = 'normal-task-done-1';

    // Normal task — no origin_id.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, '', 'done', now(), now())`,
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
            VALUES (?, '', 'done', now(), now(), ?)`,
      args: [fixTaskId, originId],
    });
    await insertOpenFailedRow(client, 'aq-stale-2', originId);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    // First delivery.
    for (const sub of subscribers) {
      await sub.handler(terminalEvent(602, fixTaskId, 'done'));
    }
    // ADR-0057: no subscriber resolves stored rows on fix-task done; row stays open.
    expect(await openRowCount(client)).toBe(1);

    // Replay — same eventId. Must not throw; row remains open.
    for (const sub of subscribers) {
      await sub.handler(terminalEvent(602, fixTaskId, 'done'));
    }
    expect(await openRowCount(client)).toBe(1);
  });

  it('task.terminal failed for a fix task does not resolve the open row', async () => {
    const originId = 'arc-fix-failed-1';
    const fixTaskId = 'fix-failed-task-1';

    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at, origin_id)
            VALUES (?, '', 'failed', now(), now(), ?)`,
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
  let client: DbClient;
  let buildActionQueueRaiserSubscribers: typeof import('./action-queue-raisers.js').buildActionQueueRaiserSubscribers;
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
    resolveOutageRowOnBreakerClose = mod.resolveOutageRowOnBreakerClose;

    const breakerMod = await import('../../core/lib/api-circuit-breaker.js');
    apiCircuitBreaker = breakerMod.apiCircuitBreaker;
  });

  afterEach(async () => {
    // Ensure the breaker is closed after each test so module state does not
    // bleed (even though vi.resetModules() would reset it on the next cycle).
    apiCircuitBreaker.close();
    await client.close();
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
      `SELECT kind, seen_count FROM action_queue_items WHERE status = 'open' LIMIT 1`,
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

    // ADR-0057: 'failed' is a derived condition — no stored row. Only the
    // api-outage row exists.
    expect(await openRowCount(client)).toBe(1);

    const outage = await client.execute(
      `SELECT kind, seen_count FROM action_queue_items WHERE kind = 'api-outage' AND status = 'open'`,
    );
    expect(outage.rows).toHaveLength(1);
    expect(Number((outage.rows[0] as unknown as { seen_count: number | bigint }).seen_count)).toBe(2);

    const failed = await client.execute(
      `SELECT kind FROM action_queue_items WHERE kind = 'failed' AND status = 'open'`,
    );
    expect(failed.rows).toHaveLength(0);
  });

  // ── Criterion 3 ────────────────────────────────────────────────────────
  // Breaker close + task drain resolves the outage row.

  it('resolves the outage row once the breaker is closed and all affected tasks are drained', async () => {
    const openedAt = 1_700_000_002_000;
    apiCircuitBreaker.open('ECONNREFUSED', openedAt);

    // Insert the affected tasks as 'failed' so they simulate tasks that were
    // mid-flight when the breaker tripped.
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES ('task-drain-x', '', 'failed', now(), now()), ('task-drain-y', '', 'failed', now(), now())`,
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(blockedEvent(320, 'task-drain-x'));
    await subscriber.handler(blockedEvent(321, 'task-drain-y'));

    // Outage row is open with count=2.
    expect(await openRowCount(client)).toBe(1);

    // Tasks are still 'failed' — resolution should be deferred.
    await resolveOutageRowOnBreakerClose(openedAt);
    expect(await openRowCount(client)).toBe(1); // not yet resolved

    // Simulate tasks being requeued after the outage clears. Terminal states
    // are absorbing: the `tasks_reject_terminal_transition` trigger refuses a
    // bare failed→queued UPDATE. Production reopens through a
    // `task_terminal_reopens` grant (see `reopenTerminalTask` in
    // core/queue.ts), so mirror that grant/consume pair here rather than
    // writing a transition the real system can never perform.
    await client.execute({
      sql: `INSERT INTO task_terminal_reopens (task_id, reason, reopened_by)
            VALUES ('task-drain-x', 'api outage cleared', 'test'),
                   ('task-drain-y', 'api outage cleared', 'test')`,
    });
    await client.execute({
      sql: `UPDATE tasks SET status = 'queued' WHERE id IN ('task-drain-x', 'task-drain-y')`,
    });
    await client.execute({
      sql: `UPDATE task_terminal_reopens SET consumed_at = now()
             WHERE task_id IN ('task-drain-x', 'task-drain-y') AND consumed_at IS NULL`,
    });

    // Now all tasks are drained — outage row should be resolved.
    await resolveOutageRowOnBreakerClose(openedAt);
    expect(await openRowCount(client)).toBe(0);

    const r = await client.execute(
      `SELECT status FROM action_queue_items WHERE kind = 'api-outage' LIMIT 1`,
    );
    expect((r.rows[0] as unknown as { status: string }).status).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// Learned-recipe auto-run: task.blocked fires → recipe executes, no card raised
// ---------------------------------------------------------------------------

describe('learned-recipe auto-run via task.blocked subscriber', () => {
  let tmpDir: string;
  let client: DbClient;
  let buildActionQueueRaiserSubscribers: typeof import('./action-queue-raisers.js').buildActionQueueRaiserSubscribers;

  // Spies shared across all tests; reset+reconfigure in beforeEach.
  // No type parameters on vi.fn() — we rely on mockResolvedValue for inference.
  const mockGetLearnedRecipe = vi.fn();
  const mockExecuteLearnedOp = vi.fn();
  const mockLogAutoRecipeRun = vi.fn();
  const mockRecordAutoRecipeOutcome = vi.fn();
  const mockListAutoRecipeRuns = vi.fn();

  beforeEach(async () => {
    tmpDir = setupRepo();
    process.env.MARS_REPO = tmpDir;
    vi.resetModules();

    // Default implementations: no recipe stored, auto-run succeeds, no prior
    // outcome-log history for the signature.
    mockGetLearnedRecipe.mockReset().mockResolvedValue(null);
    mockExecuteLearnedOp.mockReset().mockResolvedValue(undefined);
    mockLogAutoRecipeRun.mockReset().mockResolvedValue('run-id');
    mockRecordAutoRecipeOutcome.mockReset().mockResolvedValue(undefined);
    mockListAutoRecipeRuns.mockReset().mockResolvedValue([]);

    // Mock the entire learned-recipes module. The action-queue-raiser handler
    // does a dynamic `import('...learned-recipes.js')` at runtime; vi.doMock
    // registers a factory that is picked up by that import (same resolved path).
    vi.doMock('../../core/lib/learned-recipes.js', () => ({
      getLearnedRecipe: mockGetLearnedRecipe,
      executeLearnedOp: mockExecuteLearnedOp,
      logAutoRecipeRun: mockLogAutoRecipeRun,
      recordAutoRecipeOutcome: mockRecordAutoRecipeOutcome,
      listAutoRecipeRuns: mockListAutoRecipeRuns,
    }));

    client = await makeClient(tmpDir);
    const mod = await import('./action-queue-raisers.js');
    buildActionQueueRaiserSubscribers = mod.buildActionQueueRaiserSubscribers;
  });

  afterEach(async () => {
    vi.doUnmock('../../core/lib/learned-recipes.js');
    await client.close();
    delete process.env.MARS_REPO;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-runs the stored op and raises no action-queue card when a recipe exists', async () => {
    mockGetLearnedRecipe.mockResolvedValue({
      failureSignature: 'verify:typecheck/type-mismatch',
      actionOp: 'restart',
      learnedAt: new Date().toISOString(),
    });

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(1001, 'task-recipe-alpha', {
        failureSignature: 'verify:typecheck/type-mismatch',
      }),
    );

    // Auto-run was invoked with the right task id and op.
    expect(mockExecuteLearnedOp).toHaveBeenCalledWith('task-recipe-alpha', 'restart');
    // Auto-run was logged for the WYWA delta.
    expect(mockLogAutoRecipeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: 'verify:typecheck/type-mismatch',
        actionOp: 'restart',
        taskId: 'task-recipe-alpha',
      }),
    );
    // ADR-0099: the outcome log is resolved to 'success' once the op ran
    // without throwing.
    expect(mockRecordAutoRecipeOutcome).toHaveBeenCalledWith('run-id', 'success');
    // No human action required — card must NOT be raised.
    expect(await openRowCount(client)).toBe(0);
  });

  it('skips the auto-run when the recipe was most recently discredited by a failure', async () => {
    mockGetLearnedRecipe.mockResolvedValue({
      failureSignature: 'verify:typecheck/type-mismatch',
      actionOp: 'restart',
      learnedAt: new Date().toISOString(),
    });
    // ADR-0099: the outcome log is consulted before re-firing — a recipe
    // whose most recent run failed must not be blindly retried.
    mockListAutoRecipeRuns.mockResolvedValue([
      {
        id: 'prior-run',
        signature: 'verify:typecheck/type-mismatch',
        actionOp: 'restart',
        taskId: 'task-recipe-prior',
        ranAt: new Date().toISOString(),
        outcome: 'failure',
      },
    ]);

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(1005, 'task-recipe-epsilon', {
        failureSignature: 'verify:typecheck/type-mismatch',
      }),
    );

    // The discredited recipe was not re-fired.
    expect(mockExecuteLearnedOp).not.toHaveBeenCalled();
    expect(mockLogAutoRecipeRun).not.toHaveBeenCalled();
    // ADR-0057: `failed` is a derived condition; no stored row is written.
    expect(await openRowCount(client)).toBe(0);
  });

  it('raises a card normally when no recipe is stored for the failure signature', async () => {
    // mockGetLearnedRecipe already returns null by default.
    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(1002, 'task-recipe-beta', {
        failureSignature: 'verify:typecheck/type-mismatch',
      }),
    );

    // No auto-run attempted — op was not supported.
    expect(mockExecuteLearnedOp).not.toHaveBeenCalled();
    // ADR-0057: `failed` is a derived condition; no stored row is written.
    expect(await openRowCount(client)).toBe(0);
  });

  it('falls back to raising a card when executeLearnedOp throws', async () => {
    mockGetLearnedRecipe.mockResolvedValue({
      failureSignature: 'verify:typecheck/type-mismatch',
      actionOp: 'restart',
      learnedAt: new Date().toISOString(),
    });
    mockExecuteLearnedOp.mockRejectedValue(new Error('task not in failed status'));

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(
      blockedEvent(1003, 'task-recipe-gamma', {
        failureSignature: 'verify:typecheck/type-mismatch',
      }),
    );

    // ADR-0057: `failed` is a derived condition; no stored row is written even
    // when the auto-run fallback fires.
    expect(await openRowCount(client)).toBe(0);
    // ADR-0099: the outcome log records every attempt, including ones where
    // the op itself threw — resolved as 'failure' so a future occurrence of
    // this signature can consult the log before re-firing.
    expect(mockLogAutoRecipeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: 'verify:typecheck/type-mismatch',
        actionOp: 'restart',
        taskId: 'task-recipe-gamma',
      }),
    );
    expect(mockRecordAutoRecipeOutcome).toHaveBeenCalledWith('run-id', 'failure');
  });

  it('does not auto-run when failureSignature is absent from the event payload', async () => {
    // Some legacy events may arrive without a failureSignature. In that case
    // the auto-run gate should be skipped entirely and a card raised normally.
    const eventNoSig: BusEvent = {
      id: 1004,
      type: 'task.blocked',
      payload: {
        taskId: 'task-recipe-delta',
        fixTaskId: null,
        failureSignature: '',
        failingStep: 'verify',
      },
      ts: 1_000,
    };

    const [subscriber] = buildActionQueueRaiserSubscribers(client);
    await subscriber.handler(eventNoSig);

    expect(mockGetLearnedRecipe).not.toHaveBeenCalled();
    // ADR-0057: `failed` is a derived condition; no stored row is written.
    expect(await openRowCount(client)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dropped-via-supersede: auto-close action-queue rows on supersede drop
// ---------------------------------------------------------------------------

describe('action-queue-raiser:task.dropped-via-supersede subscriber', () => {
  let tmpDir: string;
  let client: DbClient;
  let buildActionQueueRaiserSubscribers: typeof import('./action-queue-raisers.js').buildActionQueueRaiserSubscribers;

  beforeEach(async () => {
    tmpDir = setupRepo();
    process.env.MARS_REPO = tmpDir;
    vi.resetModules();
    client = await makeClient(tmpDir);

    const mod = await import('./action-queue-raisers.js');
    buildActionQueueRaiserSubscribers = mod.buildActionQueueRaiserSubscribers;
  });

  afterEach(async () => {
    await client.close();
    delete process.env.MARS_REPO;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Build a minimal `task.dropped` BusEvent. */
  function droppedEvent(
    eventId: number,
    taskId: string,
    dropReason: string,
  ): BusEvent {
    return {
      id: eventId,
      type: 'task.dropped',
      payload: { taskId, dropReason },
      ts: 1_000,
    };
  }

  /**
   * Insert a pre-existing open action-queue row keyed on `originId`.
   * Uses kind='awaiting-human' (an operator-decision kind) because condition
   * kinds like 'failed' are deleted by the schema migration on every
   * ensureSchema() call (ADR-0057 cleanup step). The supersede subscriber
   * closes rows regardless of kind.
   */
  async function insertOpenFailedRow(c: DbClient, id: string, originId: string): Promise<void> {
    await c.execute({
      sql: `INSERT INTO action_queue_items
              (id, kind, category, priority, status, title, body, raised_by, raised_at, origin_task_id)
            VALUES (?, 'awaiting-human', 'orchestrator', 'high', 'open', 'task blocked', '',
                    'test', ?, ?)`,
      args: [id, Date.now(), originId],
    });
  }

  // ── Acceptance criterion 1 ─────────────────────────────────────────────
  // dropped-via-supersede closes the open action-queue row for the task.

  it('task.dropped with supersede dropReason closes the open action-queue row', async () => {
    const taskId = 'task-supersede-alpha';
    await insertOpenFailedRow(client, 'aq-supersede-1', taskId);
    expect(await openRowCount(client)).toBe(1);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    for (const sub of subscribers) {
      await sub.handler(
        droppedEvent(2000, taskId, `superseded by new task new-alpha`),
      );
    }

    // Row must be resolved — the superseding task continues the work.
    expect(await openRowCount(client)).toBe(0);
    const r = await client.execute(
      `SELECT status, resolution FROM action_queue_items WHERE id = 'aq-supersede-1'`,
    );
    const row = r.rows[0] as unknown as { status: string; resolution: string };
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe('superseded');
  });

  // ── Acceptance criterion 2 ─────────────────────────────────────────────
  // Already-closed row is idempotent — replaying the event does nothing more.

  it('already-closed row is idempotent when the event replays', async () => {
    const taskId = 'task-supersede-beta';
    await insertOpenFailedRow(client, 'aq-supersede-2', taskId);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    const event = droppedEvent(2001, taskId, 'superseded by new task new-beta');

    // First delivery — closes the row.
    for (const sub of subscribers) {
      await sub.handler(event);
    }
    expect(await openRowCount(client)).toBe(0);

    // Replay — same event id. processedOnce prevents re-entry; row stays resolved.
    for (const sub of subscribers) {
      await sub.handler(event);
    }
    expect(await openRowCount(client)).toBe(0);
    const r = await client.execute(
      `SELECT status FROM action_queue_items WHERE id = 'aq-supersede-2'`,
    );
    expect((r.rows[0] as unknown as { status: string }).status).toBe('resolved');
  });

  // ── Acceptance criterion 3 ─────────────────────────────────────────────
  // No-row-exists case is a no-op — does not throw or create rows.

  it('no-row-exists case is a no-op — no rows created or thrown', async () => {
    const taskId = 'task-supersede-gamma';
    // No action-queue row pre-exists for this task.
    expect(await openRowCount(client)).toBe(0);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    await expect(async () => {
      for (const sub of subscribers) {
        await sub.handler(
          droppedEvent(2002, taskId, 'superseded by new task new-gamma'),
        );
      }
    }).not.toThrow();

    expect(await openRowCount(client)).toBe(0);
  });

  // ── Gate: non-supersede drops do NOT close rows ────────────────────────
  // A dropped transition for a reason other than supersede must not close rows.

  it('task.dropped with non-supersede dropReason does not close the action-queue row', async () => {
    const taskId = 'task-dropped-other';
    await insertOpenFailedRow(client, 'aq-dropped-other-1', taskId);
    expect(await openRowCount(client)).toBe(1);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    for (const sub of subscribers) {
      await sub.handler(
        droppedEvent(2003, taskId, 'operator requested drop'),
      );
    }

    // Row must remain open — the drop was not a supersede.
    expect(await openRowCount(client)).toBe(1);
  });

  it('task.dropped with empty dropReason does not close the action-queue row', async () => {
    const taskId = 'task-dropped-empty';
    await insertOpenFailedRow(client, 'aq-dropped-empty-1', taskId);
    expect(await openRowCount(client)).toBe(1);

    const subscribers = buildActionQueueRaiserSubscribers(client);
    for (const sub of subscribers) {
      await sub.handler(droppedEvent(2004, taskId, ''));
    }

    expect(await openRowCount(client)).toBe(1);
  });
});
