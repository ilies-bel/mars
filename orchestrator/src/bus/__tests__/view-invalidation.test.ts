/**
 * Tests for the view-invalidation subscriber: `VIEW_CHANNEL_FOR` (the
 * kind → channel table) and `registerViewInvalidation` (the bus wiring
 * that reads it).
 *
 * Deliberately no DB fixture here — `registerViewInvalidation` operates
 * purely on an in-process `EventEmitter` and a `ViewStreamHub`, mirroring
 * `proposal-sse-broadcast.test.ts`'s existing hand-wired-listener tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ViewStreamHub } from '../../core/daemon/view/stream-hub.js';
import { EventMap } from '../events.js';
import { TRACE_EVENT_KINDS } from '../../core/lib/trace-events-store.js';
import { VIEW_CHANNEL_FOR, registerViewInvalidation } from '../view-invalidation.js';

describe('VIEW_CHANNEL_FOR', () => {
  it('has an entry for every registered bus EventName', () => {
    for (const key of Object.keys(EventMap)) {
      expect(Object.prototype.hasOwnProperty.call(VIEW_CHANNEL_FOR, key)).toBe(true);
    }
  });

  it('has an entry for every registered TraceEventKind', () => {
    for (const kind of TRACE_EVENT_KINDS) {
      expect(Object.prototype.hasOwnProperty.call(VIEW_CHANNEL_FOR, kind)).toBe(true);
    }
  });

  it('is exhaustive over the union — no stray keys beyond the two registries', () => {
    const known = new Set<string>([...Object.keys(EventMap), ...TRACE_EVENT_KINDS]);
    for (const key of Object.keys(VIEW_CHANNEL_FOR)) {
      expect(known.has(key)).toBe(true);
    }
  });
});

describe('registerViewInvalidation', () => {
  it('emits the mapped channel(s) on the hub when the bus emits a mapped kind', () => {
    const bus = new EventEmitter();
    const hub = new ViewStreamHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcast');

    registerViewInvalidation(bus, hub);
    bus.emit('task.added');

    expect(broadcastSpy).toHaveBeenCalledWith('tasks');
  });

  it('broadcasts every mapped channel for a kind with more than one', () => {
    const bus = new EventEmitter();
    const hub = new ViewStreamHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcast');

    registerViewInvalidation(bus, hub);
    bus.emit('task.completed');

    expect(broadcastSpy).toHaveBeenCalledWith('tasks');
    expect(broadcastSpy).toHaveBeenCalledWith('progress');
    expect(broadcastSpy).toHaveBeenCalledTimes(2);
  });

  it('proposal lifecycle kinds broadcast progress, matching the existing hand-wired behaviour', () => {
    const bus = new EventEmitter();
    const hub = new ViewStreamHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcast');

    registerViewInvalidation(bus, hub);
    bus.emit('proposal.added');
    bus.emit('proposal.promoted');

    expect(broadcastSpy).toHaveBeenNthCalledWith(1, 'progress');
    expect(broadcastSpy).toHaveBeenNthCalledWith(2, 'progress');
    expect(broadcastSpy).toHaveBeenCalledTimes(2);
  });

  it('does not register a listener for a kind mapped to no channels', () => {
    const bus = new EventEmitter();
    const hub = new ViewStreamHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcast');

    expect(VIEW_CHANNEL_FOR['signal.recorded']).toEqual([]);

    registerViewInvalidation(bus, hub);
    bus.emit('signal.recorded');

    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('is idempotent-per-call: registering once wires exactly one listener per mapped kind', () => {
    const bus = new EventEmitter();
    const hub = new ViewStreamHub();
    const broadcastSpy = vi.spyOn(hub, 'broadcast');

    registerViewInvalidation(bus, hub);
    bus.emit('task.blocked');

    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledWith('tasks');
  });
});
