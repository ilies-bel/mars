import { execFile } from 'node:child_process';
import type { DbClient } from '../../core/lib/db.js';
import { getNotificationsEnabled } from '../../core/store/state-store.js';
import type { Subscriber } from '../dispatcher.js';
import type { BusEvent } from '../../bus/events.js';
import { registerSubscriberName } from '../registry.js';

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
 * Fire exactly one osascript invocation for the buffered alerts:
 * - One alert  → named banner: `display notification "<label>" with title "Mars"`
 * - Two+ alerts → collapsed banner titled `"Mars — N new alerts"`.
 *
 * Errors are swallowed — explicit exception to ADR-0032's stall-and-raise
 * protocol. See the notifier ADR for rationale.
 */
function flush(): void {
  const alerts = pendingAlerts.splice(0);
  flushTimer = null;
  if (alerts.length === 0) return;

  const script =
    alerts.length === 1
      ? `display notification "${alerts[0].title}" with title "Mars"`
      : `display notification "" with title "Mars — ${alerts.length} new alerts"`;

  try {
    execFile(
      'osascript',
      ['-e', script],
      () => {
        // Callback intentionally empty — errors are swallowed.
      },
    );
  } catch {
    // Swallow synchronous spawn errors — best-effort delivery.
    // Explicit exception to ADR-0032; see the notifier ADR.
  }
}

/**
 * Build the Outbox Subscriber that shows a native macOS notification
 * when one or more action-queue items are raised within a debounce window.
 *
 * Delivery is best-effort:
 * - On non-Darwin platforms the subscriber is a silent no-op; the cursor
 *   still advances.
 * - When `notifications_enabled` is OFF, the subscriber advances without
 *   dispatching.
 * - Any shell error (osascript failure, permission denied, no display) is
 *   swallowed; the cursor still advances.
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
 */
export function buildDesktopNotifySubscriber(
  db: DbClient,
  platform: string = process.platform,
): Subscriber {
  return {
    name: DESKTOP_NOTIFY_SUBSCRIBER,
    handler: async (event: BusEvent): Promise<void> => {
      if (event.type !== 'action-queue.raised') return;

      // Non-Darwin platforms: silent no-op — cursor advances.
      if (platform !== 'darwin') return;

      // Preference gate: if notifications are disabled, advance without dispatch.
      const enabled = await getNotificationsEnabled(db);
      if (!enabled) return;

      const p = event.payload as {
        itemId: string;
        kind: string;
        category: string;
        priority: string;
        signature: string | null;
      };

      // Use the human-readable signature when present; fall back to the raw
      // item id. The signature encodes the alert key (e.g.
      // "task.blocked:task-abc123" or "stale-worktree:wt-xyz").
      const label = p.signature ?? p.itemId;
      // Escape backslashes and double-quotes so the label is safe inside an
      // AppleScript string literal.
      const escaped = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      // Buffer the alert and (re)start the debounce timer.
      // The handler returns immediately so the outbox cursor advances before
      // the window elapses — flush is a separate, decoupled concern.
      pendingAlerts.push({ title: escaped });
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, NOTIFY_DEBOUNCE_MS);
      }
    },
  };
}
