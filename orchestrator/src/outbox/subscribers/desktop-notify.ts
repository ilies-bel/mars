import { execFile } from 'node:child_process';
import type { Client } from '@libsql/client';
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
 * Build the Outbox Subscriber that shows a native macOS notification
 * the moment an action-queue item is raised.
 *
 * Delivery is best-effort:
 * - On non-Darwin platforms the subscriber is a silent no-op; the cursor
 *   still advances.
 * - When `notifications_enabled` is OFF, the subscriber advances without
 *   dispatching.
 * - Any shell error (osascript failure, permission denied, no display) is
 *   swallowed; the cursor still advances.
 *
 * This subscriber does NOT subscribe to `task.failed` — it leans on the
 * per-arc origin dedup already applied at the action-queue.raised layer so
 * one failing arc yields exactly one notification.
 *
 * Explicit exception to ADR-0032's stall-and-raise protocol: notification
 * delivery errors must NOT stall the subscriber cursor — see the notifier
 * ADR for rationale.
 *
 * @param db        The shared mars.db client used to read notification
 *                  preferences.
 * @param platform  The runtime platform string (defaults to
 *                  `process.platform`). Override in tests to exercise
 *                  platform-conditional branches without mocking globals.
 */
export function buildDesktopNotifySubscriber(
  db: Client,
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

      // ADR-0032 exception: notification errors must never stall the cursor.
      // Fire-and-forget: execFile returns immediately; osascript runs
      // asynchronously, and any callback error is silently discarded.
      // The synchronous try/catch covers the (rare) case where execFile
      // itself throws before spawning the process (e.g. ENOENT when the
      // osascript binary is missing). See the notifier ADR for rationale.
      try {
        execFile(
          'osascript',
          ['-e', `display notification "${escaped}" with title "Mars"`],
          () => {
            // Callback intentionally empty — errors are swallowed.
          },
        );
      } catch {
        // Swallow synchronous spawn errors — best-effort delivery.
        // Explicit exception to ADR-0032; see the notifier ADR.
      }
    },
  };
}
