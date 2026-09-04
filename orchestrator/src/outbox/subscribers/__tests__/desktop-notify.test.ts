/**
 * Condition notification reconciler — behaviour tests.
 *
 * Covers the new `runConditionNotifyReconciler` exported from
 * `desktop-notify.ts`.  Tests drive the reconciler directly with injected
 * fakes so they stay fast, deterministic, and free of real DB calls or OS
 * shell commands.
 *
 * Verified scenarios (per task spec):
 *   1. A newly-derived condition notifies exactly once.
 *   2. A second evaluation with unchanged state notifies zero times.
 *   3. A condition that disappears and later recurs notifies again.
 *   4. N same-signature `failed` conditions aggregate into one notification.
 *   5. A simulated daemon restart with a populated watermark notifies zero times.
 *
 * Additionally:
 *   6. Notifications-disabled preference skips all delivery.
 *   7. Non-failed conditions each produce their own notification (no cross-kind collapse).
 *   8. NotifierBackend seam: buildDesktopNotifySubscriber accepts a custom notifier.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before the module-under-test is imported.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../../core/store/state-store.js', () => ({
  getNotificationsEnabled: vi.fn(),
}));

import { getNotificationsEnabled } from '../../../core/store/state-store.js';
import {
  runConditionNotifyReconciler,
  buildDesktopNotifySubscriber,
  createDarwinNotifier,
  type NotifierBackend,
  type ConditionWatermarkStore,
  type ConditionWatermark,
  type ConditionNotifyReconcilerDeps,
  __resetForTests,
} from '../desktop-notify.js';
import type { PersistedActionQueueRow, ConditionItemsSource } from '../../../core/daemon/view/action-queue.js';
import type { DbClient } from '../../../core/lib/db.js';

// ---------------------------------------------------------------------------
// Typed mocks
// ---------------------------------------------------------------------------
const mockGetEnabled = vi.mocked(getNotificationsEnabled);

// Stub DB — never queried because getNotificationsEnabled is mocked.
const db = {} as DbClient;

// ---------------------------------------------------------------------------
// Fake helpers
// ---------------------------------------------------------------------------

/** Build a minimal PersistedActionQueueRow for a `failed` condition. */
function makeFailedRow(overrides?: {
  taskId?: string;
  failureSignature?: string | null;
}): PersistedActionQueueRow {
  const taskId = overrides?.taskId ?? 'task-abc';
  const failureSig = overrides?.failureSignature !== undefined
    ? overrides.failureSignature
    : 'merge:timeout';
  return {
    id: `derived-${taskId}`,
    kind: 'failed',
    priority: 'high',
    title: `Task ${taskId} failed`,
    body: '',
    payload: {
      taskId,
      failureSignature: failureSig,
    },
    context: { taskId },
    raisedAt: Date.now(),
    lastSeenAt: Date.now(),
    signature: `failed:${taskId}`,
  };
}

/** Build a minimal PersistedActionQueueRow for a non-failed condition. */
function makeConditionRow(kind: string, entityId: string): PersistedActionQueueRow {
  return {
    id: `derived-${kind}-${entityId}`,
    kind,
    priority: 'high',
    title: `${kind}: ${entityId}`,
    body: '',
    payload: {},
    context: {},
    raisedAt: Date.now(),
    lastSeenAt: Date.now(),
    signature: `${kind}:${entityId}`,
  };
}

/** Create an in-memory ConditionItemsSource that returns a fixed set of rows. */
function makeConditionSource(rows: PersistedActionQueueRow[]): ConditionItemsSource {
  return {
    async derive() {
      return rows;
    },
  };
}

/** Create an in-memory watermark store (simulates the app_settings-backed store). */
function makeInMemoryWatermarkStore(
  initial?: ConditionWatermark,
): ConditionWatermarkStore & { _data: ConditionWatermark } {
  const data: ConditionWatermark = initial ? new Map(initial) : new Map();
  return {
    _data: data,
    async read() { return new Map(data); },
    async write(wm) {
      data.clear();
      for (const [k, v] of wm) data.set(k, v);
    },
  };
}

/** Create a spy-able NotifierBackend. */
function makeNotifier(): NotifierBackend & { calls: Array<Array<{ title: string }>> } {
  const calls: Array<Array<{ title: string }>> = [];
  return {
    calls,
    send(alerts) { calls.push([...alerts]); },
  };
}

/**
 * Build deps with sensible defaults. Returns a concrete object so callers can
 * access `.notifier.calls` and `.watermarkStore._data` without extra casts.
 */
function makeDeps(overrides: {
  rows?: PersistedActionQueueRow[];
  watermark?: ConditionWatermark;
  notifier?: ReturnType<typeof makeNotifier>;
  conditionSource?: ConditionItemsSource;
  nowMs?: number;
}): {
  conditionSource: ConditionItemsSource;
  db: DbClient;
  notifier: ReturnType<typeof makeNotifier>;
  watermarkStore: ReturnType<typeof makeInMemoryWatermarkStore>;
  nowMs: number;
} {
  const notifier = overrides.notifier ?? makeNotifier();
  const watermarkStore = makeInMemoryWatermarkStore(overrides.watermark);
  const conditionSource =
    overrides.conditionSource ?? makeConditionSource(overrides.rows ?? []);
  return {
    conditionSource,
    db,
    notifier,
    watermarkStore,
    nowMs: overrides.nowMs ?? 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('condition notification reconciler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetForTests();
    mockGetEnabled.mockResolvedValue(true);
  });

  afterEach(() => {
    __resetForTests();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1: Newly-derived condition notifies exactly once
  // ─────────────────────────────────────────────────────────────────────────

  describe('scenario 1 — newly derived condition notifies once', () => {
    it('sends exactly one notification when one new condition appears', async () => {
      const deps = makeDeps({ rows: [makeFailedRow({ taskId: 'task-1' })] });
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls).toHaveLength(1);
    });

    it('notification contains the condition signature label', async () => {
      const deps = makeDeps({ rows: [makeFailedRow({ taskId: 'task-1', failureSignature: 'merge:timeout' })] });
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls[0]).toHaveLength(1);
      // Single condition: label derived from signature
      const alertTitle = deps.notifier.calls[0][0].title;
      expect(alertTitle).toContain('task-1');
    });

    it('adds the condition to the watermark after notification', async () => {
      const deps = makeDeps({ rows: [makeFailedRow({ taskId: 'task-1' })] });
      await runConditionNotifyReconciler(deps);
      expect(deps.watermarkStore._data.has('failed:task-1')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 2: Second evaluation with unchanged state notifies zero times
  // ─────────────────────────────────────────────────────────────────────────

  describe('scenario 2 — idempotent: unchanged state notifies zero times on second run', () => {
    it('notifies zero times on the second run with the same conditions', async () => {
      const rows = [makeFailedRow({ taskId: 'task-1' })];
      const deps = makeDeps({ rows });

      // First run: notifies once.
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls).toHaveLength(1);

      // Second run with same state: no new notifications.
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls).toHaveLength(1); // unchanged
    });

    it('watermark contains exactly the current conditions after two runs', async () => {
      const rows = [makeFailedRow({ taskId: 'task-1' }), makeConditionRow('gate-broken', 'gate-x')];
      const deps = makeDeps({ rows });
      await runConditionNotifyReconciler(deps);
      await runConditionNotifyReconciler(deps);
      expect(deps.watermarkStore._data.size).toBe(2);
      expect(deps.watermarkStore._data.has('failed:task-1')).toBe(true);
      expect(deps.watermarkStore._data.has('gate-broken:gate-x')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 3: A condition that disappears and recurs notifies again
  // ─────────────────────────────────────────────────────────────────────────

  describe('scenario 3 — disappeared and recurred condition re-notifies', () => {
    it('notifies when a previously-disappeared condition comes back', async () => {
      const row = makeFailedRow({ taskId: 'task-2' });
      let rows = [row];
      const conditionSource: ConditionItemsSource = {
        async derive() { return rows; },
      };
      const deps = makeDeps({ conditionSource });

      // Run 1: condition present → notifies.
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls).toHaveLength(1);

      // Run 2: condition disappears (e.g. task was resolved).
      rows = [];
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls).toHaveLength(1); // no new notification

      // Watermark must no longer contain the disappeared condition.
      expect(deps.watermarkStore._data.has('failed:task-2')).toBe(false);

      // Run 3: same condition reappears (e.g. new failure with same task id).
      rows = [row];
      await runConditionNotifyReconciler(deps);
      // Must notify again — the condition re-entered the watermark.
      expect(deps.notifier.calls).toHaveLength(2);
    });

    it('does not notify when the condition is still absent', async () => {
      const deps = makeDeps({ rows: [] });
      await runConditionNotifyReconciler(deps);
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 4: N same-signature conditions aggregate into one notification
  // ─────────────────────────────────────────────────────────────────────────

  describe('scenario 4 — N same-signature conditions produce one aggregated notification', () => {
    it('collapses 14 failed tasks with the same failureSignature into one notification', async () => {
      const rows = Array.from({ length: 14 }, (_, i) =>
        makeFailedRow({ taskId: `task-${i}`, failureSignature: 'merge:timeout' }),
      );
      const deps = makeDeps({ rows });
      await runConditionNotifyReconciler(deps);

      // Exactly one send call, with exactly one alert entry.
      expect(deps.notifier.calls).toHaveLength(1);
      expect(deps.notifier.calls[0]).toHaveLength(1);

      // The aggregated message must mention the count and the signature.
      const alertTitle = deps.notifier.calls[0][0].title;
      expect(alertTitle).toContain('14');
      expect(alertTitle).toContain('merge:timeout');
    });

    it('does not aggregate conditions from different failure signatures', async () => {
      const rows = [
        makeFailedRow({ taskId: 'task-a', failureSignature: 'merge:timeout' }),
        makeFailedRow({ taskId: 'task-b', failureSignature: 'verify:failed' }),
      ];
      const deps = makeDeps({ rows });
      await runConditionNotifyReconciler(deps);

      // Two different groups → two alerts in one send call.
      expect(deps.notifier.calls).toHaveLength(1);
      expect(deps.notifier.calls[0]).toHaveLength(2);
    });

    it('does not aggregate conditions of different non-failed kinds', async () => {
      const rows = [
        makeConditionRow('gate-broken', 'gate-1'),
        makeConditionRow('gate-broken', 'gate-2'),
      ];
      const deps = makeDeps({ rows });
      await runConditionNotifyReconciler(deps);

      // Two gate-broken conditions, different identities — both land as
      // separate alerts (gate-broken has no further aggregation key).
      expect(deps.notifier.calls).toHaveLength(1);
      expect(deps.notifier.calls[0]).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 5: Simulated daemon restart with populated watermark
  // ─────────────────────────────────────────────────────────────────────────

  describe('scenario 5 — daemon restart with populated watermark does not re-notify', () => {
    it('notifies zero times when the watermark already covers all current conditions', async () => {
      // Simulate: conditions were present before restart and were notified.
      // The watermark was persisted. A new daemon process reads it.
      const row1 = makeFailedRow({ taskId: 'task-alpha' });
      const row2 = makeConditionRow('gate-broken', 'gate-y');

      const priorWatermark: ConditionWatermark = new Map([
        ['failed:task-alpha', '2026-09-04T00:00:00.000Z'],
        ['gate-broken:gate-y', '2026-09-04T00:00:00.000Z'],
      ]);

      const deps = makeDeps({
        rows: [row1, row2],
        // The watermark is pre-populated — simulates persistence across restart.
        watermark: priorWatermark,
      });

      await runConditionNotifyReconciler(deps);

      // No new notifications: conditions were already in the watermark.
      expect(deps.notifier.calls).toHaveLength(0);
    });

    it('does notify for conditions that appeared AFTER the last watermark was written', async () => {
      const priorWatermark: ConditionWatermark = new Map([
        ['failed:task-alpha', '2026-09-04T00:00:00.000Z'],
      ]);

      const rows = [
        makeFailedRow({ taskId: 'task-alpha' }),  // already in watermark
        makeFailedRow({ taskId: 'task-beta' }),   // NEW since last persist
      ];

      const deps = makeDeps({ rows, watermark: priorWatermark });
      await runConditionNotifyReconciler(deps);

      // Only task-beta is new → exactly one notification.
      expect(deps.notifier.calls).toHaveLength(1);
      const alertTitle = deps.notifier.calls[0][0].title;
      expect(alertTitle).toContain('task-beta');
      expect(alertTitle).not.toContain('task-alpha');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Preference gate
  // ─────────────────────────────────────────────────────────────────────────

  describe('preference gate', () => {
    it('sends no notifications when notifications_enabled is false', async () => {
      mockGetEnabled.mockResolvedValue(false);
      const deps = makeDeps({ rows: [makeFailedRow({ taskId: 'task-x' })] });
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls).toHaveLength(0);
    });

    it('does not update the watermark when notifications are disabled', async () => {
      mockGetEnabled.mockResolvedValue(false);
      const deps = makeDeps({ rows: [makeFailedRow({ taskId: 'task-x' })] });
      await runConditionNotifyReconciler(deps);
      // Watermark stays empty — conditions were never "notified".
      expect(deps.watermarkStore._data.size).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('sends no notification when the condition source returns an empty set', async () => {
      const deps = makeDeps({ rows: [] });
      await runConditionNotifyReconciler(deps);
      expect(deps.notifier.calls).toHaveLength(0);
    });

    it('handles conditionSource.derive() rejection gracefully', async () => {
      const conditionSource: ConditionItemsSource = {
        async derive() { throw new Error('DB unreachable'); },
      };
      const deps = makeDeps({ conditionSource });
      // Must resolve without throwing; no notification when source fails.
      await expect(runConditionNotifyReconciler(deps)).resolves.toBeUndefined();
      expect(deps.notifier.calls).toHaveLength(0);
    });

    it('collapses failed conditions with null failureSignature under "unknown"', async () => {
      const rows = [
        makeFailedRow({ taskId: 'task-a', failureSignature: null }),
        makeFailedRow({ taskId: 'task-b', failureSignature: null }),
      ];
      const deps = makeDeps({ rows });
      await runConditionNotifyReconciler(deps);

      // Both group under "failed:unknown" → one aggregated notification.
      expect(deps.notifier.calls).toHaveLength(1);
      expect(deps.notifier.calls[0]).toHaveLength(1);
      const alertTitle = deps.notifier.calls[0][0].title;
      expect(alertTitle).toContain('2');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Platform-agnostic notifier seam tests
// ─────────────────────────────────────────────────────────────────────────────

describe('NotifierBackend seam', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetForTests();
    mockGetEnabled.mockResolvedValue(true);
  });

  afterEach(() => {
    __resetForTests();
    vi.useRealTimers();
  });

  it('buildDesktopNotifySubscriber accepts a custom NotifierBackend via third param', async () => {
    const { execFile } = await import('node:child_process');
    const mockExecFile = vi.mocked(execFile);

    const customNotifier = makeNotifier();
    const sub = buildDesktopNotifySubscriber(db, 'darwin', customNotifier);

    vi.useFakeTimers();
    await sub.handler({
      id: 1,
      type: 'action-queue.raised',
      payload: { itemId: 'item-1', kind: 'failed', category: 'orchestrator', priority: 'high', signature: 'failed:task-z' },
      ts: Date.now(),
    });
    vi.advanceTimersByTime(30_000);

    // Custom notifier was called; osascript was NOT called.
    expect(customNotifier.calls).toHaveLength(1);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('buildDesktopNotifySubscriber on darwin with no notifier uses osascript', async () => {
    const { execFile } = await import('node:child_process');
    const mockExecFile = vi.mocked(execFile);

    const sub = buildDesktopNotifySubscriber(db, 'darwin');
    vi.useFakeTimers();
    await sub.handler({
      id: 1,
      type: 'action-queue.raised',
      payload: { itemId: 'item-1', kind: 'failed', category: 'orchestrator', priority: 'high', signature: 'failed:task-z' },
      ts: Date.now(),
    });
    vi.advanceTimersByTime(30_000);
    expect(mockExecFile).toHaveBeenCalledOnce();
  });

  it('createDarwinNotifier returns a NotifierBackend that calls execFile with osascript', async () => {
    const { execFile } = await import('node:child_process');
    const mockExecFile = vi.mocked(execFile);

    const notifier = createDarwinNotifier();
    notifier.send([{ title: 'test alert' }]);

    expect(mockExecFile).toHaveBeenCalledOnce();
    const [cmd, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('test alert');
  });
});
