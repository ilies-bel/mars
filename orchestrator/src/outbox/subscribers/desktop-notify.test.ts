/**
 * desktop-notify Outbox Subscriber — behaviour tests.
 *
 * These tests drive the subscriber handler directly (without a running
 * dispatcher) so every assertion is synchronous and deterministic.
 *
 * Both `node:child_process` and the state-store preference reader are mocked
 * at the module boundary so the tests stay fast and fully isolated — no
 * real DB, no real shell commands.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the module-under-test is imported.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../core/store/state-store.js', () => ({
  getNotificationsEnabled: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { getNotificationsEnabled } from '../../core/store/state-store.js';
import {
  buildDesktopNotifySubscriber,
  DESKTOP_NOTIFY_SUBSCRIBER,
} from './desktop-notify.js';
import type { BusEvent } from '../../bus/events.js';
import type { Client } from '@libsql/client';

// Typed mocks — avoids littering tests with `as unknown as X` casts.
const mockExecFile = vi.mocked(execFile);
const mockGetEnabled = vi.mocked(getNotificationsEnabled);

// A dummy Client stub — the real DB is never queried because the preference
// reader is mocked at module level.
const db = {} as Client;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRaisedEvent(overrides?: {
  signature?: string | null;
  itemId?: string;
}): BusEvent {
  return {
    id: 1,
    type: 'action-queue.raised',
    payload: {
      itemId: overrides?.itemId ?? 'item-abc',
      kind: 'task-blocked',
      category: 'orchestrator',
      priority: 'high',
      signature:
        overrides?.signature !== undefined
          ? overrides.signature
          : 'task.blocked:task-xyz',
    },
    ts: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('desktop-notify subscriber', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Subscriber registration / event filter contract
  // -------------------------------------------------------------------------

  it('name identifies action-queue.raised and is not registered against task.failed', () => {
    const sub = buildDesktopNotifySubscriber(db, 'darwin');
    expect(sub.name).toBe(DESKTOP_NOTIFY_SUBSCRIBER);
    // The name must encode the event it consumes, not task.failed.
    expect(sub.name).toContain('action-queue.raised');
    expect(sub.name).not.toContain('task.failed');
  });

  it('ignores task.failed events without dispatching', async () => {
    mockGetEnabled.mockResolvedValue(true);
    const sub = buildDesktopNotifySubscriber(db, 'darwin');
    const event: BusEvent = {
      id: 2,
      type: 'task.failed',
      payload: { taskId: 'task-1', error: 'boom' },
      ts: Date.now(),
    };
    await sub.handler(event);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Darwin + notifications enabled → osascript is invoked
  // -------------------------------------------------------------------------

  describe('darwin platform, notifications enabled', () => {
    beforeEach(() => {
      mockGetEnabled.mockResolvedValue(true);
    });

    it('invokes osascript with display notification and Mars title', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent());

      expect(mockExecFile).toHaveBeenCalledOnce();
      const [cmd, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      expect(cmd).toBe('osascript');
      expect(args[0]).toBe('-e');
      expect(args[1]).toMatch(/display notification/);
      expect(args[1]).toContain('with title "Mars"');
    });

    it('embeds the signature in the notification message', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent({ signature: 'task.blocked:task-xyz' }));

      const [, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      expect(args[1]).toContain('task.blocked:task-xyz');
    });

    it('falls back to itemId when signature is null', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent({ signature: null, itemId: 'item-fallback' }));

      expect(mockExecFile).toHaveBeenCalledOnce();
      const [, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      expect(args[1]).toContain('item-fallback');
    });

    it('escapes double-quotes in the label so AppleScript is not broken', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent({ signature: 'say "hello"' }));

      const [, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      // The label should have its double-quotes escaped.
      expect(args[1]).toContain('\\"hello\\"');
    });
  });

  // -------------------------------------------------------------------------
  // Notifications disabled → no shell command, cursor still advances
  // -------------------------------------------------------------------------

  describe('darwin platform, notifications disabled', () => {
    beforeEach(() => {
      mockGetEnabled.mockResolvedValue(false);
    });

    it('does not invoke osascript', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent());
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('resolves without throwing so the cursor advances', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await expect(sub.handler(makeRaisedEvent())).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Non-Darwin platform → silent no-op, cursor still advances
  // -------------------------------------------------------------------------

  describe('non-darwin platform', () => {
    it('does not invoke osascript on linux', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'linux');
      await sub.handler(makeRaisedEvent());
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('does not invoke osascript on win32', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'win32');
      await sub.handler(makeRaisedEvent());
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('resolves without throwing so the cursor advances', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'linux');
      await expect(sub.handler(makeRaisedEvent())).resolves.toBeUndefined();
    });

    it('never queries the preference DB (early return before DB access)', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'linux');
      await sub.handler(makeRaisedEvent());
      // getNotificationsEnabled must not have been called — we returned early.
      expect(mockGetEnabled).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // execFile throws synchronously → error swallowed, cursor still advances
  // -------------------------------------------------------------------------

  describe('when execFile throws synchronously', () => {
    beforeEach(() => {
      mockGetEnabled.mockResolvedValue(true);
      mockExecFile.mockImplementation(() => {
        throw new Error('spawn error: ENOENT');
      });
    });

    it('swallows the error and resolves so the cursor advances', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      // Must resolve, not reject — ADR-0032 exception for best-effort delivery.
      await expect(sub.handler(makeRaisedEvent())).resolves.toBeUndefined();
    });
  });
});
