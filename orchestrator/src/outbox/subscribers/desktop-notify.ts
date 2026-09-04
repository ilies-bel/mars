import { execFile } from 'node:child_process';
import type { DbClient } from '../../core/lib/db.js';
import { getNotificationsEnabled } from '../../core/store/state-store.js';
import type { Subscriber } from '../dispatcher.js';
import type { BusEvent } from '../../bus/events.js';
import { registerSubscriberName } from '../registry.js';
import type { ConditionItemsSource, PersistedActionQueueRow } from '../../core/daemon/view/action-queue.js';

/**
 * Unique name for the desktop-notify subscriber. Registered at module-init
 * time so the ghost-subscriber reconciler sees it without a central import
 * list (mirrors the self-registration pattern used by other subscribers).
 */
export const DESKTOP_NOTIFY_SUBSCRIBER = 'desktop-notifier:action-queue.raised';
registerSubscriberName(DESKTOP_NOTIFY_SUBSCRIBER);

/**
 * Debounce window in milliseconds. Raised events that land within this window
 * are coalesced into a single notification. One alert → named banner; two or
 * more → "Mars — N new alerts" collapsed banner.
 */
export const NOTIFY_DEBOUNCE_MS = 30_000;

// ── Platform-agnostic notifier seam ─────────────────────────────────────────

/**
 * Minimal backend interface for delivering OS notifications. Dispatch routes
 * through this seam so a non-Darwin backend can be added without touching the
 * subscriber — implement and inject a concrete backend, done.
 *
 * Contract:
 * - `send` must never throw; swallow errors internally.
 * - One alert  → named banner.
 * - Two+ alerts → collapsed "N new alerts" summary.
 * - Delivery is best-effort; a transport failure must not stall anything.
 */
export interface NotifierBackend {
  send(alerts: Array<{ title: string }>): void;
}

/**
 * macOS backend — dispatches via `osascript`. Errors are swallowed.
 * This is an explicit exception to ADR-0032's stall-and-raise protocol;
 * see the notifier ADR for rationale.
 */
export function createDarwinNotifier(): NotifierBackend {
  return {
    send(alerts) {
      const script =
        alerts.length === 1
          ? `display notification "${alerts[0].title}" with title "Mars"`
          : `display notification "" with title "Mars — ${alerts.length} new alerts"`;
      try {
        execFile('osascript', ['-e', script], () => {
          // Callback intentionally empty — errors are swallowed.
        });
      } catch {
        // Swallow synchronous spawn errors — best-effort delivery.
      }
    },
  };
}

// Module-scoped mutable buffer — alerts accumulate here until the debounce
// timer fires. Both fields are module-level so they survive across handler
// invocations (one subscriber instance may handle many events per daemon run).
let pendingAlerts: Array<{ title: string }> = [];
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Reset module-level debounce state between test runs. Not part of the public
 * API — intended only for test isolation via `__resetForTests()`.
 */
export function __resetForTests(): void {
  pendingAlerts = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/**
 * Fire exactly one notification invocation for the buffered alerts:
 * - One alert  → named banner: `display notification "<label>" with title "Mars"`
 * - Two+ alerts → collapsed banner titled `"Mars — N new alerts"`.
 *
 * Errors are swallowed — explicit exception to ADR-0032's stall-and-raise
 * protocol. See the notifier ADR for rationale.
 */
function flush(notifier: NotifierBackend): void {
  const alerts = pendingAlerts.splice(0);
  flushTimer = null;
  if (alerts.length === 0) return;
  notifier.send(alerts);
}

/**
 * Buffer `alert` and (re)start the debounce timer so multiple alerts
 * arriving close together coalesce into a single flush.
 */
function bufferAndScheduleFlush(alert: { title: string }, notifier: NotifierBackend): void {
  pendingAlerts.push(alert);
  if (flushTimer === null) {
    flushTimer = setTimeout(() => flush(notifier), NOTIFY_DEBOUNCE_MS);
  }
}

/**
 * Build the Outbox Subscriber that shows a native OS notification when one or
 * more action-queue items are raised within a debounce window.
 *
 * Delivery is best-effort:
 * - When no `notifier` is supplied, defaults to the macOS osascript backend on
 *   darwin and a silent no-op on all other platforms; the cursor still advances.
 * - When `notifications_enabled` is OFF, the subscriber advances without
 *   dispatching.
 * - Any transport error is swallowed; the cursor still advances.
 * - Cursor advancement is independent of the flush timer: the handler pushes
 *   the label into the pending buffer and returns immediately, so the outbox
 *   cursor advances before the debounce window elapses.
 *
 * This subscriber does NOT subscribe to `task.failed` — it leans on the
 * per-arc origin dedup already applied at the action-queue.raised layer so
 * one failing arc yields exactly one notification.
 *
 * Explicit exception to ADR-0032's stall-and-raise protocol: notification
 * delivery errors must NOT stall the subscriber cursor — see the notifier
 * ADR for rationale.
 *
 * @param db        The shared DB client used to read notification
 *                  preferences.
 * @param platform  The runtime platform string (defaults to
 *                  `process.platform`). Override in tests to exercise
 *                  platform-conditional branches without mocking globals.
 * @param notifier  Optional backend seam. When omitted, the darwin backend
 *                  is used on macOS and a no-op is used on other platforms.
 *                  Inject a custom backend in tests or to add a new platform.
 */
export function buildDesktopNotifySubscriber(
  db: DbClient,
  platform: string = process.platform,
  notifier?: NotifierBackend | null,
): Subscriber {
  // Resolve the backend once, at build time, so every handler invocation
  // shares the same instance (and thus the same module-level buffer).
  const resolvedNotifier: NotifierBackend | null =
    notifier !== undefined
      ? notifier
      : platform === 'darwin'
        ? createDarwinNotifier()
        : null;

  return {
    name: DESKTOP_NOTIFY_SUBSCRIBER,
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'action-queue.raised') return;

      // Non-Darwin platforms with no explicit backend: silent no-op.
      if (resolvedNotifier === null) return;

      // Preference gate: if notifications are disabled, advance without dispatch.
      const enabled = await getNotificationsEnabled(db);
      if (!enabled) return;

      const p = event.payload as {
        itemId: string;
        kind: string;
        category: string;
        priority: string;
        signature: string | null;
        humanSummary?: string;
      };

      // Prefer the plain-language humanSummary so the system banner shows a
      // readable sentence (e.g. "Task mars-abc failed at verify"). Fall back
      // to the signature, then to the raw item id.
      const label = p.humanSummary ?? p.signature ?? p.itemId;
      // Escape backslashes and double-quotes so the label is safe inside an
      // AppleScript string literal.
      const escaped = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      bufferAndScheduleFlush({ title: escaped }, resolvedNotifier);
    },
  };
}

// ── Condition notification reconciler ────────────────────────────────────────

/**
 * Stable identity key for a derived condition. Uses the row's `signature`
 * field, which encodes kind + entity (e.g. `failed:task-abc123`). When
 * `signature` is absent (should not happen for derived kinds, but guards
 * against future drift), falls back to `kind:id`.
 */
function conditionKey(row: { kind: string; signature?: string | null; id: string }): string {
  return row.signature ?? `${row.kind}:${row.id}`;
}

/**
 * Notification-group key used for storm aggregation.
 *
 * For `failed` conditions: groups by the failure-signature string (the error
 * pattern, e.g. `merge:timeout`). This prevents N tasks failing with the same
 * error from producing N separate notifications — they collapse into one
 * "N tasks failed with <pattern>" message.
 *
 * For all other condition kinds: uses the condition identity (its stable
 * `signature` field) so each distinct condition remains its own group. Two
 * `gate-broken` conditions for different gates are different alerts; only
 * `failed` conditions share a collapse dimension beyond identity.
 */
function notifGroupKey(row: {
  kind: string;
  id: string;
  signature?: string | null;
  payload: Record<string, unknown>;
}): string {
  if (row.kind === 'failed') {
    const sig = typeof row.payload.failureSignature === 'string'
      ? row.payload.failureSignature
      : 'unknown';
    return `failed:${sig}`;
  }
  // Non-failed: every distinct condition is its own group.
  return row.signature ?? `${row.kind}:${row.id}`;
}

/**
 * Watermark: maps condition identity → ISO timestamp when first notified.
 *
 * Keyed by `conditionKey(row)` so the same condition — same kind, same
 * subject — produces the same watermark entry across evaluations. A
 * condition absent from the watermark has never been notified (or was
 * previously notified but then disappeared, which removes it from the
 * watermark so a recurrence re-notifies).
 */
export type ConditionWatermark = Map<string, string>; // key → notifiedAt ISO

/**
 * Injectable watermark store. Tests provide an in-memory implementation;
 * the daemon wires a DB-backed one via `app_settings`.
 */
export interface ConditionWatermarkStore {
  read(): Promise<ConditionWatermark>;
  write(watermark: ConditionWatermark): Promise<void>;
}

/**
 * Build a `ConditionWatermarkStore` backed by the `app_settings` table.
 * Key: `notification:condition-watermark`. Durable across daemon restarts.
 */
export function createDbWatermarkStore(db: DbClient): ConditionWatermarkStore {
  const SETTINGS_KEY = 'notification:condition-watermark';
  return {
    async read(): Promise<ConditionWatermark> {
      try {
        const result = await db.execute({
          sql: `SELECT value FROM app_settings WHERE key = ?`,
          args: [SETTINGS_KEY],
        });
        if (result.rows.length === 0) return new Map();
        const raw = (result.rows[0] as { value: string }).value;
        const parsed = JSON.parse(raw) as Record<string, string>;
        return new Map(Object.entries(parsed));
      } catch {
        return new Map();
      }
    },
    async write(watermark: ConditionWatermark): Promise<void> {
      const obj: Record<string, string> = {};
      for (const [k, v] of watermark) obj[k] = v;
      const value = JSON.stringify(obj);
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO app_settings (key, value, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [SETTINGS_KEY, value, now],
      });
    },
  };
}

/**
 * Dependencies for the condition notification reconciler.
 */
export interface ConditionNotifyReconcilerDeps {
  /** Evaluates the full derived condition set on every call. */
  conditionSource: ConditionItemsSource;
  /** DB client for reading the notification preference. */
  db: DbClient;
  /** Backend to deliver the notification. */
  notifier: NotifierBackend;
  /** Durable watermark store — keyed by stable condition identity. */
  watermarkStore: ConditionWatermarkStore;
  /** Override "now" timestamp for testing. */
  nowMs?: number;
}

/**
 * Run one reconciliation cycle:
 *
 * 1. Check notification preference — abort if disabled.
 * 2. Derive the current set of condition-kind items.
 * 3. Diff against the last-notified watermark.
 * 4. Notify the user about newly appearing conditions, aggregated by
 *    failure-signature to prevent notification storms (N tasks failing with
 *    the same signature → one aggregated message).
 * 5. Update the watermark: add new conditions, remove disappeared ones.
 *
 * **Idempotent**: running twice with the same state produces exactly one
 * notification (on the first run) and zero on the second.
 *
 * **Storm-safe**: N `failed` conditions sharing the same `failureSignature`
 * are collapsed into one notification reporting the count.
 *
 * **Restart-safe**: the watermark is durable, so a daemon restart does not
 * re-notify conditions that were already holding at shutdown.
 */
export async function runConditionNotifyReconciler(
  deps: ConditionNotifyReconcilerDeps,
): Promise<void> {
  const { conditionSource, db, notifier, watermarkStore } = deps;

  // Preference gate first — avoids the DB read entirely when disabled.
  const enabled = await getNotificationsEnabled(db);
  if (!enabled) return;

  // Derive current condition set.
  const currentRows: PersistedActionQueueRow[] = await conditionSource.derive({}).catch((): PersistedActionQueueRow[] => []);

  // Build a map: conditionKey → row.
  const currentByKey = new Map<string, (typeof currentRows)[number]>();
  for (const row of currentRows) {
    currentByKey.set(conditionKey(row), row);
  }

  // Read the persisted watermark.
  const watermark = await watermarkStore.read();

  // --- Diff ---
  const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString();

  // Newly present: in current but not in watermark.
  const newRows: Array<(typeof currentRows)[number]> = [];
  for (const [key, row] of currentByKey) {
    if (!watermark.has(key)) {
      newRows.push(row);
    }
  }

  // Disappeared: in watermark but not in current — remove from watermark so a
  // recurrence later is treated as new.
  for (const key of Array.from(watermark.keys())) {
    if (!currentByKey.has(key)) {
      watermark.delete(key);
    }
  }

  // --- Notify ---
  if (newRows.length > 0) {
    // Group by notification key to aggregate same-signature failures.
    const groups = new Map<string, Array<(typeof currentRows)[number]>>();
    for (const row of newRows) {
      const key = notifGroupKey(row);
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(row);
    }

    const alerts: Array<{ title: string }> = [];
    for (const [groupKey, rows] of groups) {
      if (rows.length === 1) {
        const row = rows[0];
        // Use signature as the human label when available; fall back to title.
        const label = row.signature ?? row.title;
        const escaped = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        alerts.push({ title: escaped });
      } else {
        // Aggregated: derive a human label from the group key.
        // groupKey is e.g. "failed:merge:timeout" or "failed:unknown".
        const match = /^failed:(.+)$/.exec(groupKey);
        const sigLabel = match ? match[1] : groupKey;
        const escaped = sigLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        alerts.push({ title: `${rows.length} tasks failed with ${escaped}` });
      }
    }

    notifier.send(alerts);
  }

  // --- Update watermark ---
  for (const [key] of currentByKey) {
    if (!watermark.has(key)) {
      watermark.set(key, nowIso);
    }
  }
  await watermarkStore.write(watermark);
}
