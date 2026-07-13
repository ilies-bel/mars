/**
 * desktop-notify Outbox Subscriber — behaviour tests.
 *
 * These tests drive the subscriber handler directly (without a running
 * dispatcher) so every assertion is synchronous and deterministic.
 *
 * Both `node:child_process` and the state-store preference reader are mocked
 * at the module boundary so the tests stay fast and fully isolated — no
 * real DB, no real shell commands.
 *
 * Fake timers are used throughout to control the 30-second debounce window
 * without wall-clock waits.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

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
  NOTIFY_DEBOUNCE_MS,
  __resetForTests,
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
    // Install fake timers BEFORE resetting module state so clearTimeout uses
    // the fake implementation consistently across the test run.
    vi.useFakeTimers();
    __resetForTests();
  });

  afterEach(() => {
    __resetForTests();
    vi.useRealTimers();
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
    vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Darwin + notifications enabled → osascript is invoked after flush
  // -------------------------------------------------------------------------

  describe('darwin platform, notifications enabled', () => {
    beforeEach(() => {
      mockGetEnabled.mockResolvedValue(true);
    });

    it('invokes osascript with display notification and Mars title after debounce window', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent());

      // osascript not called yet — timer is pending
      expect(mockExecFile).not.toHaveBeenCalled();

      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);

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

      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);

      const [, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      expect(args[1]).toContain('task.blocked:task-xyz');
    });

    it('falls back to itemId when signature is null', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent({ signature: null, itemId: 'item-fallback' }));

      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);

      expect(mockExecFile).toHaveBeenCalledOnce();
      const [, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      expect(args[1]).toContain('item-fallback');
    });

    it('escapes double-quotes in the label so AppleScript is not broken', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent({ signature: 'say "hello"' }));

      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);

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
      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
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
      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('does not invoke osascript on win32', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'win32');
      await sub.handler(makeRaisedEvent());
      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
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
      // Handler returns before the flush fires, so it always resolves.
      await expect(sub.handler(makeRaisedEvent())).resolves.toBeUndefined();
    });

    it('swallows the execFile throw inside flush and does not propagate', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent());
      // flush() catches the throw internally — advancing the timer must not throw.
      expect(() => vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Debounce / coalescing behaviour
  // -------------------------------------------------------------------------

  describe('debounce window coalescing', () => {
    beforeEach(() => {
      mockGetEnabled.mockResolvedValue(true);
    });

    it('NOTIFY_DEBOUNCE_MS is exported as 30_000', () => {
      expect(NOTIFY_DEBOUNCE_MS).toBe(30_000);
    });

    it('handler resolves before the flush timer fires (cursor advancement is independent)', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');

      const handlerPromise = sub.handler(makeRaisedEvent());
      // Resolve the handler — should not wait for the timer.
      await handlerPromise;

      // Timer has not fired yet: osascript must not have been called.
      expect(mockExecFile).not.toHaveBeenCalled();

      // Advance to trigger flush.
      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
      expect(mockExecFile).toHaveBeenCalledOnce();
    });

    it('single alert in window → named banner with the alert label', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent({ signature: 'task.blocked:task-abc' }));

      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);

      expect(mockExecFile).toHaveBeenCalledOnce();
      const [cmd, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      expect(cmd).toBe('osascript');
      expect(args[1]).toContain('task.blocked:task-abc');
      expect(args[1]).toContain('with title "Mars"');
      // Must NOT use the collapsed format.
      expect(args[1]).not.toContain('new alerts');
    });

    it('two alerts in window → single collapsed banner titled "Mars — 2 new alerts"', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent({ signature: 'sig-a' }));
      await sub.handler(makeRaisedEvent({ signature: 'sig-b' }));

      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);

      // Exactly one osascript invocation.
      expect(mockExecFile).toHaveBeenCalledOnce();
      const [, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      expect(args[1]).toContain('Mars — 2 new alerts');
      // Individual labels must not appear in the collapsed banner.
      expect(args[1]).not.toContain('sig-a');
      expect(args[1]).not.toContain('sig-b');
    });

    it('three alerts in window → single collapsed banner with correct count', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent({ signature: 'alpha' }));
      await sub.handler(makeRaisedEvent({ signature: 'beta' }));
      await sub.handler(makeRaisedEvent({ signature: 'gamma' }));

      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);

      expect(mockExecFile).toHaveBeenCalledOnce();
      const [, args] = mockExecFile.mock.calls[0] as unknown as [string, string[]];
      expect(args[1]).toContain('Mars — 3 new alerts');
    });

    it('two separate bursts separated by a full window → two separate flushes', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'darwin');

      // First burst: one event.
      await sub.handler(makeRaisedEvent({ signature: 'burst-1' }));

      // Advance to flush first burst.
      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const firstCall = (mockExecFile.mock.calls[0] as unknown as [string, string[]])[1];
      expect(firstCall[1]).toContain('burst-1');

      // Second burst: two events within the new window.
      await sub.handler(makeRaisedEvent({ signature: 'burst-2a' }));
      await sub.handler(makeRaisedEvent({ signature: 'burst-2b' }));

      // Advance to flush second burst.
      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      const secondCall = (mockExecFile.mock.calls[1] as unknown as [string, string[]])[1];
      expect(secondCall[1]).toContain('Mars — 2 new alerts');
    });

    it('disabled preference → no flushes even after window elapses', async () => {
      mockGetEnabled.mockResolvedValue(false);
      const sub = buildDesktopNotifySubscriber(db, 'darwin');
      await sub.handler(makeRaisedEvent());
      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('non-darwin → no flushes even after window elapses', async () => {
      const sub = buildDesktopNotifySubscriber(db, 'linux');
      await sub.handler(makeRaisedEvent());
      vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});
