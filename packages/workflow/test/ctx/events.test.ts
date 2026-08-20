import { describe, it, expect, vi } from 'vitest';
import { Context, isBailed, safeEmit } from '../../src/ctx/index.js';

describe('ctx.on', () => {
  it('registering returns a disposer that removes the listener', () => {
    const ctx = new Context();
    const fn = vi.fn();
    const off = ctx.on('ping', fn);

    ctx.emit('ping', 1);
    expect(fn).toHaveBeenCalledTimes(1);

    off();
    ctx.emit('ping', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('has no listenerCount — a listener is an effect, observable through its disposer', () => {
    const ctx = new Context();
    const seen: number[] = [];
    const off1 = ctx.on('ping', (n: number) => seen.push(n));
    const off2 = ctx.on('ping', (n: number) => seen.push(n * 10));

    ctx.emit('ping', 1);
    expect(seen).toEqual([1, 10]);

    off1();
    ctx.emit('ping', 2);
    expect(seen).toEqual([1, 10, 20]);

    off2();
    ctx.emit('ping', 3);
    expect(seen).toEqual([1, 10, 20]);
  });

  it('once() fires at most once', () => {
    const ctx = new Context();
    const fn = vi.fn();
    ctx.once('ping', fn);

    ctx.emit('ping', 1);
    ctx.emit('ping', 2);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('listeners are effects of the registering fiber and go away with it', async () => {
    const ctx = new Context();
    const fn = vi.fn();
    const fiber = await ctx.plugin({
      name: 'listens',
      apply(pluginCtx) {
        pluginCtx.on('ping', fn);
      },
    });

    ctx.emit('ping', 1);
    expect(fn).toHaveBeenCalledTimes(1);

    await fiber.dispose();

    ctx.emit('ping', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('ctx.emit — synchronous, return values ignored', () => {
  it('invokes every listener in registration order without awaiting async ones', async () => {
    const ctx = new Context();
    const order: number[] = [];
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    ctx.on('ping', () => {
      order.push(1);
    });
    ctx.on('ping', async () => {
      await slow;
      order.push(2);
    });
    ctx.on('ping', () => {
      order.push(3);
    });

    ctx.emit('ping', 0);
    expect(order).toEqual([1, 3]);

    releaseSlow?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1, 3, 2]);
  });

  it('CORDIS SEMANTICS: a throwing listener reaches the emitter and skips the rest', () => {
    // Documented, deliberate difference from the dispatcher this replaced.
    // `safeEmit` below is how the engine gets the old isolation back.
    const ctx = new Context();
    const order: string[] = [];
    ctx.on('ping', () => order.push('first'));
    ctx.on('ping', () => {
      throw new Error('sync boom');
    });
    ctx.on('ping', () => order.push('third'));

    expect(() => ctx.emit('ping', 0)).toThrow('sync boom');
    expect(order).toEqual(['first']);
  });
});

describe('safeEmit — fault-isolated dispatch (the engine channel)', () => {
  it('a throwing listener is reported and does not stop the remaining listeners', () => {
    const errors: unknown[] = [];
    const ctx = new Context();
    const order: string[] = [];

    ctx.on('ping', () => order.push('first'));
    ctx.on('ping', () => {
      throw new Error('sync boom');
    });
    ctx.on('ping', () => order.push('third'));

    expect(() => safeEmit(ctx, 'ping', [0], (error) => errors.push(error))).not.toThrow();
    expect(order).toEqual(['first', 'third']);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('sync boom');
  });

  it('an async listener rejection is routed to onError, not left unhandled', async () => {
    const errors: unknown[] = [];
    const ctx = new Context();
    ctx.on('ping', async () => {
      throw new Error('async boom');
    });

    expect(() => safeEmit(ctx, 'ping', [0], (error) => errors.push(error))).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('async boom');
  });

  it('passes every argument through, in order', () => {
    const ctx = new Context();
    const seen: unknown[][] = [];
    ctx.on('ping', (...args: unknown[]) => {
      seen.push(args);
    });

    safeEmit(ctx, 'ping', [1, 'two', { three: true }]);

    expect(seen).toEqual([[1, 'two', { three: true }]]);
  });

  it('swallows by default when no error handler is supplied', () => {
    const ctx = new Context();
    ctx.on('ping', () => {
      throw new Error('unobserved');
    });
    expect(() => safeEmit(ctx, 'ping', [])).not.toThrow();
  });
});

describe('ctx.parallel — awaited, concurrent', () => {
  it('resolves once every listener has settled', async () => {
    const ctx = new Context();
    const order: string[] = [];

    ctx.on('ping', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('slow');
    });
    ctx.on('ping', () => {
      order.push('fast');
    });

    await ctx.parallel('ping', 0);

    expect(order.sort()).toEqual(['fast', 'slow']);
  });

  it('aggregates rejections into a single AggregateError instead of swallowing them', async () => {
    const ctx = new Context();
    ctx.on('ping', () => {
      throw new Error('first');
    });
    ctx.on('ping', async () => {
      throw new Error('second');
    });
    ctx.on('ping', () => {
      // succeeds — must not appear in the aggregate
    });

    await expect(ctx.parallel('ping', 0)).rejects.toBeInstanceOf(AggregateError);

    try {
      await ctx.parallel('ping', 0);
      expect.unreachable();
    } catch (error) {
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors.map((e: Error) => e.message).sort()).toEqual(['first', 'second']);
    }
  });
});

describe('ctx.serial / ctx.bail — first BAILED value wins', () => {
  it('stops at the first bailed value, in registration order', async () => {
    const ctx = new Context();
    const called: string[] = [];

    ctx.on('classify', (s: string) => {
      called.push('first');
      return s === 'a' ? 'matched-a' : undefined;
    });
    ctx.on('classify', (s: string) => {
      called.push('second');
      return s === 'b' ? 'matched-b' : undefined;
    });
    ctx.on('classify', () => {
      called.push('third');
      return 'fallback';
    });

    const result = await ctx.serial('classify', 'b');

    expect(result).toBe('matched-b');
    expect(called).toEqual(['first', 'second']);
  });

  it('BREAK FROM THE NATIVE DISPATCHER: `false` and `null` no longer short-circuit', async () => {
    // The old dispatcher stopped at the first non-`undefined` value. Cordis
    // stops at the first value for which `isBailed()` holds, and `isBailed`
    // rejects null, false AND undefined. A heuristic returning `false` now
    // keeps the chain going.
    expect(isBailed(false)).toBe(false);
    expect(isBailed(null)).toBe(false);
    expect(isBailed(undefined)).toBe(false);
    expect(isBailed(0)).toBe(true);
    expect(isBailed('')).toBe(true);

    const ctx = new Context();
    const called: string[] = [];
    ctx.on('classify', () => {
      called.push('returns-false');
      return false;
    });
    ctx.on('classify', () => {
      called.push('returns-null');
      return null;
    });
    ctx.on('classify', () => {
      called.push('wins');
      return 'won';
    });

    expect(await ctx.serial('classify', 'x')).toBe('won');
    expect(called).toEqual(['returns-false', 'returns-null', 'wins']);
  });

  it('returns undefined when no listener produces a bailed value, and when there are none', async () => {
    const ctx = new Context();
    expect(await ctx.serial('classify', 'z')).toBeUndefined();

    ctx.on('classify', () => undefined);
    ctx.on('classify', () => undefined);
    expect(await ctx.serial('classify', 'z')).toBeUndefined();
  });

  it('bail is the synchronous serial', () => {
    const ctx = new Context();
    ctx.on('classify', () => undefined);
    ctx.on('classify', () => 'sync-winner');

    expect(ctx.bail('classify', 'x')).toBe('sync-winner');
  });
});

describe('ctx.waterfall — onion middleware, not a fold', () => {
  it('runs listeners outermost-first around an innermost `next`', () => {
    // The native dispatcher threaded a seed VALUE through each listener. Cordis
    // composes listeners AROUND a final callback: each receives the dispatch
    // args plus `next`, and wraps the rest of the chain.
    const ctx = new Context();
    ctx.on('compose', (_prompt: string, next: () => string) => `<${next()}>`);
    ctx.on('compose', (_prompt: string, next: () => string) => `[${next()}]`);

    expect(ctx.waterfall('compose', 'seed', () => 'inner')).toBe('<[inner]>');
  });

  it('a listener that never calls next() vetoes the rest of the chain', () => {
    const ctx = new Context();
    const downstream = vi.fn();
    ctx.on('compose', () => 'vetoed');
    ctx.on('compose', (_prompt: string, next: () => string) => {
      downstream();
      return next();
    });

    expect(ctx.waterfall('compose', 'seed', () => 'inner')).toBe('vetoed');
    expect(downstream).not.toHaveBeenCalled();
  });

  it('falls through to the innermost callback when there are no listeners', () => {
    const ctx = new Context();
    expect(ctx.waterfall('compose', 'seed', () => 'inner')).toBe('inner');
  });
});
