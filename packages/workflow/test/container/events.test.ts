import { describe, it, expect, vi } from 'vitest';
import { createEventDispatcher } from '../../src/container/index.js';

interface TestEvents {
  ping: (n: number) => void;
  classify: (s: string) => string | undefined;
  compose: (prompt: string, extra: string) => string;
}

describe('EventDispatcher.on', () => {
  it('registering returns a disposer that removes the listener', () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    const fn = vi.fn();
    const off = dispatcher.on('ping', fn);

    dispatcher.emit('ping', 1);
    expect(fn).toHaveBeenCalledTimes(1);

    off();
    dispatcher.emit('ping', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('listenerCount reflects registrations and removals', () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    expect(dispatcher.listenerCount('ping')).toBe(0);
    const off1 = dispatcher.on('ping', () => {});
    const off2 = dispatcher.on('ping', () => {});
    expect(dispatcher.listenerCount('ping')).toBe(2);
    off1();
    expect(dispatcher.listenerCount('ping')).toBe(1);
    off2();
    expect(dispatcher.listenerCount('ping')).toBe(0);
  });
});

describe('EventDispatcher.emit — fire-and-forget, sequential', () => {
  it('invokes every listener, in registration order, without waiting for async listeners', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    const order: number[] = [];
    let resolveSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });

    dispatcher.on('ping', () => {
      order.push(1);
    });
    dispatcher.on('ping', async () => {
      await slow;
      order.push(2);
    });
    dispatcher.on('ping', () => {
      order.push(3);
    });

    dispatcher.emit('ping', 0);

    // Synchronous listeners have already run; the async one hasn't reached
    // its push(2) yet because emit() does not await it.
    expect(order).toEqual([1, 3]);

    resolveSlow?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 3, 2]);
  });

  it('a throwing listener is reported and does not stop the remaining listeners', () => {
    const dispatcher = createEventDispatcher<TestEvents>({ onError: (e) => errors.push(e) });
    const errors: unknown[] = [];
    const order: string[] = [];

    dispatcher.on('ping', () => order.push('first'));
    dispatcher.on('ping', () => {
      throw new Error('sync boom');
    });
    dispatcher.on('ping', () => order.push('third'));

    expect(() => dispatcher.emit('ping', 0)).not.toThrow();
    expect(order).toEqual(['first', 'third']);
    expect(errors).toHaveLength(1);
  });

  it('an async listener rejection is routed to onError, not thrown', async () => {
    const errors: unknown[] = [];
    const dispatcher = createEventDispatcher<TestEvents>({ onError: (e) => errors.push(e) });
    dispatcher.on('ping', async () => {
      throw new Error('async boom');
    });

    expect(() => dispatcher.emit('ping', 0)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('async boom');
  });
});

describe('EventDispatcher.parallel — awaited, concurrent', () => {
  it('resolves once every listener has settled', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    const order: string[] = [];

    dispatcher.on('ping', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('slow');
    });
    dispatcher.on('ping', () => {
      order.push('fast');
    });

    await dispatcher.parallel('ping', 0);

    expect(order.sort()).toEqual(['fast', 'slow']);
  });

  it('aggregates rejections into a single AggregateError instead of swallowing them', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    dispatcher.on('ping', () => {
      throw new Error('first');
    });
    dispatcher.on('ping', async () => {
      throw new Error('second');
    });
    dispatcher.on('ping', () => {
      // succeeds — should not appear in the aggregate
    });

    await expect(dispatcher.parallel('ping', 0)).rejects.toBeInstanceOf(AggregateError);

    try {
      await dispatcher.parallel('ping', 0);
      expect.unreachable();
    } catch (error) {
      const agg = error as AggregateError;
      expect(agg.errors).toHaveLength(2);
      expect(agg.errors.map((e: Error) => e.message).sort()).toEqual(['first', 'second']);
    }
  });
});

describe('EventDispatcher.serial — awaited, first non-undefined result wins', () => {
  it('stops at the first listener returning a defined value, in registration order', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    const called: string[] = [];

    dispatcher.on('classify', (s) => {
      called.push('first');
      return s === 'a' ? 'matched-a' : undefined;
    });
    dispatcher.on('classify', (s) => {
      called.push('second');
      return s === 'b' ? 'matched-b' : undefined;
    });
    dispatcher.on('classify', (s) => {
      called.push('third');
      return 'fallback';
    });

    const result = await dispatcher.serial('classify', 'b');

    expect(result).toBe('matched-b');
    // The third listener never runs — the second one already won.
    expect(called).toEqual(['first', 'second']);
  });

  it('returns undefined when no listener produces a defined value', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    dispatcher.on('classify', () => undefined);
    dispatcher.on('classify', () => undefined);

    const result = await dispatcher.serial('classify', 'z');

    expect(result).toBeUndefined();
  });

  it('returns undefined immediately when there are no listeners', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    const result = await dispatcher.serial('classify', 'z');
    expect(result).toBeUndefined();
  });
});

describe('EventDispatcher.waterfall — awaited, chained transform', () => {
  it('threads the seed through every listener in registration order', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();

    dispatcher.on('compose', (prompt: string) => `${prompt}+one`);
    dispatcher.on('compose', async (prompt: string) => `${prompt}+two`);
    dispatcher.on('compose', (prompt: string) => `${prompt}+three`);

    const result = await dispatcher.waterfall('compose', 'seed', 'extra');

    expect(result).toBe('seed+one+two+three');
  });

  it('returns the seed unchanged when there are no listeners', async () => {
    const dispatcher = createEventDispatcher<TestEvents>();
    const result = await dispatcher.waterfall('compose', 'seed', 'extra');
    expect(result).toBe('seed');
  });
});
