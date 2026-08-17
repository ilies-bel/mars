import { describe, it, expect, vi } from 'vitest';
import { Context, FiberState, fiberStateName, isActive, isDisposed } from '../../src/ctx/index.js';
import type { Fiber } from '../../src/ctx/index.js';

/** Record every state transition a plugin fiber makes, as readable names. */
function transitionLog(ctx: Context, ignore: Fiber): string[] {
  const log: string[] = [];
  ctx.on('internal/status', (fiber, oldState) => {
    if (fiber === ignore) return;
    log.push(`${fiberStateName(oldState)}->${fiberStateName(fiber.state)}`);
  });
  return log;
}

describe('fiber lifecycle', () => {
  it('walks PENDING -> LOADING -> ACTIVE -> UNLOADING -> DISPOSED', async () => {
    const ctx = new Context();
    const log = transitionLog(ctx, ctx.fiber);

    const fiber = ctx.plugin({ name: 'lifecycle', inject: ['db'], apply() {} });
    expect(fiber.state).toBe(FiberState.PENDING);

    ctx.provide('db', {});
    await fiber.await();
    expect(isActive(fiber)).toBe(true);

    await fiber.dispose();
    expect(isDisposed(fiber)).toBe(true);

    expect(log).toEqual([
      'PENDING->LOADING',
      'LOADING->ACTIVE',
      'ACTIVE->UNLOADING',
      'UNLOADING->DISPOSED',
    ]);
  });

  it('a throwing apply() lands the fiber in FAILED and rejects fiber.await()', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin({
      name: 'explodes',
      apply() {
        throw new Error('apply exploded');
      },
    });

    await expect(fiber.await()).rejects.toThrow('apply exploded');
    expect(fiber.state).toBe(FiberState.FAILED);
    // A FAILED fiber is not disposed — it still owns its slot and can restart.
    expect(isDisposed(fiber)).toBe(false);
  });

  it('restart() re-runs the plugin body on the same fiber', async () => {
    const ctx = new Context();
    const applied = vi.fn();
    const teardown = vi.fn();
    const fiber = await ctx.plugin({
      name: 'restartable',
      apply(pluginCtx) {
        applied();
        pluginCtx.effect(() => teardown);
      },
    });

    await fiber.restart();

    expect(applied).toHaveBeenCalledTimes(2);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(fiber.state).toBe(FiberState.ACTIVE);
  });

  it('restart() on a disposed fiber throws INACTIVE_EFFECT', async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin({ name: 'gone', apply() {} });
    await fiber.dispose();

    await expect(fiber.restart()).rejects.toThrow(/inactive context/);
  });

  it('a fiber names itself from the nearest named ancestor', async () => {
    const ctx = new Context();
    expect(ctx.fiber.name).toBe('root');

    const fiber = await ctx.plugin({ name: 'named-plugin', apply() {} });
    expect(fiber.name).toBe('named-plugin');
  });

  it('only an ACTIVE fiber\'s services are visible to a strict get()', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin({
      name: 'provider',
      inject: ['db'],
      apply(pluginCtx) {
        pluginCtx.provide('derived', 'value');
      },
    });
    expect(fiber.state).toBe(FiberState.PENDING);
    expect(ctx.get('derived')).toBeUndefined();

    ctx.provide('db', {});
    await fiber.await();

    expect(ctx.get('derived')).toBe('value');
  });
});
