import { describe, it, expect, vi } from 'vitest';
import { Context, CordisError } from '../../src/ctx/index.js';

describe('ctx.effect — reversible registration', () => {
  it('runs disposers in reverse registration order', async () => {
    const order: string[] = [];
    const ctx = new Context();
    ctx.effect(() => () => order.push('a'), 'a');
    ctx.effect(() => () => order.push('b'), 'b');
    ctx.effect(() => () => order.push('c'), 'c');

    await ctx.fiber.dispose();

    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('is idempotent: disposing twice runs the disposer once', async () => {
    const fn = vi.fn();
    const ctx = new Context();
    ctx.effect(() => fn);

    await ctx.fiber.dispose();
    await ctx.fiber.dispose();
    await ctx.fiber.dispose();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('an effect disposer can be called directly, before teardown, and only fires once', async () => {
    const fn = vi.fn();
    const ctx = new Context();
    const dispose = ctx.effect(() => fn);

    await dispose();
    await dispose();
    await ctx.fiber.dispose();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing disposer does not stop the rest of the teardown', async () => {
    const order: string[] = [];
    const ctx = new Context();
    ctx.effect(() => () => order.push('first'), 'first');
    ctx.effect(() => () => {
      throw new Error('boom');
    }, 'thrower');
    ctx.effect(() => () => order.push('third'), 'third');

    await expect(ctx.fiber.dispose()).resolves.toBeUndefined();

    expect(order).toEqual(['third', 'first']);
    // Cordis routes the failure into its logger rather than an onError option.
    expect(ctx.logger.buffer.some((message) => message.type === 'error')).toBe(true);
  });

  it('a generator effect registers each yielded disposer and unwinds them in reverse', async () => {
    const order: string[] = [];
    const ctx = new Context();
    ctx.effect(function* () {
      yield () => order.push('lease');
      yield () => order.push('slot');
      yield () => order.push('preview');
    }, 'acquire-all');

    await ctx.fiber.dispose();

    expect(order).toEqual(['preview', 'slot', 'lease']);
  });

  it('getEffects() exposes the labelled teardown tree', () => {
    const ctx = new Context();
    ctx.effect(() => () => {}, 'worktree-lease');
    ctx.effect(() => () => {}, 'verify-slot');

    expect(ctx.fiber.getEffects().map((meta) => meta.label)).toEqual([
      'worktree-lease',
      'verify-slot',
    ]);
  });

  it('BREAK FROM THE NATIVE DisposerSet: registering on a disposed fiber THROWS', async () => {
    // The old DisposerSet ran a late-added disposer immediately. Cordis refuses:
    // a disposed fiber owns nothing, so there is nothing to reverse later.
    const ctx = new Context();
    const fiber = await ctx.plugin({ name: 'short-lived', apply() {} });
    const pluginCtx = fiber.ctx;

    await fiber.dispose();

    expect(() => pluginCtx.effect(() => () => {})).toThrow(CordisError);
    expect(() => pluginCtx.effect(() => () => {})).toThrow(/inactive context/);
  });

  it('rejects an effect body that returns something other than a disposer', () => {
    const ctx = new Context();
    const badEffect = () => 'not a disposer' as unknown as () => void;
    expect(() => ctx.effect(badEffect)).toThrow(TypeError);
  });

  it('a child fiber\'s effects are torn down with it, leaving the parent alone', async () => {
    const order: string[] = [];
    const ctx = new Context();
    ctx.effect(() => () => order.push('parent'), 'parent');

    const fiber = await ctx.plugin({
      name: 'child',
      apply(pluginCtx) {
        pluginCtx.effect(() => () => order.push('child'), 'child');
      },
    });

    await fiber.dispose();
    expect(order).toEqual(['child']);

    await ctx.fiber.dispose();
    expect(order).toEqual(['child', 'parent']);
  });
});
