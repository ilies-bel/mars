import { describe, it, expect, vi } from 'vitest';
import { Context, FiberState, isDisposed } from '../../src/ctx/index.js';

describe('ctx.plugin — inject gating', () => {
  it('applies immediately when the injected dependencies are already present', async () => {
    const ctx = new Context();
    ctx.provide('store', { records: [] });
    const applied = vi.fn();

    const fiber = await ctx.plugin({
      name: 'immediate',
      inject: ['store'],
      apply(pluginCtx) {
        applied(pluginCtx.get('store'));
      },
    });

    expect(applied).toHaveBeenCalledWith({ records: [] });
    expect(fiber.state).toBe(FiberState.ACTIVE);
  });

  it('defers apply() until EVERY injected dependency is present, then applies exactly once', async () => {
    const ctx = new Context();
    const applied = vi.fn();
    const fiber = ctx.plugin({
      name: 'deferred',
      inject: ['store', 'agent'],
      apply: applied,
    });

    expect(fiber.state).toBe(FiberState.PENDING);

    ctx.provide('store', { records: [] });
    await fiber.await();
    expect(fiber.state).toBe(FiberState.PENDING);
    expect(applied).not.toHaveBeenCalled();

    ctx.provide('agent', { name: 'claude' });
    await fiber.await();

    expect(applied).toHaveBeenCalledTimes(1);
    expect(fiber.state).toBe(FiberState.ACTIVE);
  });

  it('a plugin with no inject list applies immediately', async () => {
    const ctx = new Context();
    const applied = vi.fn();

    const fiber = await ctx.plugin({ name: 'no-deps', apply: applied });

    expect(applied).toHaveBeenCalledTimes(1);
    expect(fiber.state).toBe(FiberState.ACTIVE);
  });

  it('an UNDECLARED service is readable via get() but never gates apply() — v4 has no `optional`', async () => {
    const ctx = new Context();
    // In cordis 4 every `inject` entry is required. "Optional" is simply not
    // declaring it and reading through `ctx.get`, which never throws.
    let seen: unknown = 'unset';
    const fiber = await ctx.plugin({
      name: 'optional-deps',
      apply(pluginCtx) {
        seen = pluginCtx.get('agent');
      },
    });

    expect(fiber.state).toBe(FiberState.ACTIVE);
    expect(seen).toBeUndefined();
  });

  it('withdrawing an injected dependency tears the plugin down; re-providing re-applies it', async () => {
    const ctx = new Context();
    const withdrawStore = ctx.provide('store', { records: [] });

    let applyCalls = 0;
    let teardownCalls = 0;
    const fiber = await ctx.plugin({
      name: 'reactive',
      inject: ['store'],
      apply(pluginCtx) {
        applyCalls += 1;
        pluginCtx.provide('derived', { level: 'info' });
        // Teardown is registered as an effect. Cordis IGNORES a disposer
        // returned from apply() — that was the native container's contract.
        pluginCtx.effect(() => () => {
          teardownCalls += 1;
        });
      },
    });

    expect(applyCalls).toBe(1);
    expect(ctx.get('derived')).toEqual({ level: 'info' });
    expect(fiber.state).toBe(FiberState.ACTIVE);

    await withdrawStore();

    expect(teardownCalls).toBe(1);
    // Everything the plugin registered while active — including services it
    // provided itself — is reversed, not just its own teardown effect.
    expect(ctx.get('derived')).toBeUndefined();
    expect(fiber.state).toBe(FiberState.PENDING);
    expect(isDisposed(fiber)).toBe(false);

    ctx.provide('store', { records: [] });
    await fiber.await();

    expect(applyCalls).toBe(2);
    expect(ctx.get('derived')).toEqual({ level: 'info' });
    expect(fiber.state).toBe(FiberState.ACTIVE);
  });

  it('fiber.dispose() tears down an active plugin and stops it from re-applying', async () => {
    const ctx = new Context();
    const withdrawStore = ctx.provide('store', { records: [] });

    let teardownCalls = 0;
    const fiber = await ctx.plugin({
      name: 'disposable',
      inject: ['store'],
      apply(pluginCtx) {
        pluginCtx.effect(() => () => {
          teardownCalls += 1;
        });
      },
    });
    expect(fiber.state).toBe(FiberState.ACTIVE);

    await fiber.dispose();

    expect(teardownCalls).toBe(1);
    expect(fiber.state).toBe(FiberState.DISPOSED);
    expect(isDisposed(fiber)).toBe(true);

    // Cycling the dependency must NOT resurrect a disposed fiber.
    await withdrawStore();
    ctx.provide('store', { records: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(teardownCalls).toBe(1);
    expect(fiber.state).toBe(FiberState.DISPOSED);
  });

  it('effects registered before an in-flight apply() is cut short still run', async () => {
    let releaseApply: (() => void) | undefined;
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const teardown = vi.fn();

    const ctx = new Context();
    const fiber = ctx.plugin({
      name: 'slow-apply',
      async apply(pluginCtx) {
        // Registered BEFORE the await: this is the cordis equivalent of the
        // native container's "a disposer returned from a slow apply() must not
        // be dropped". Anything registered after the fiber starts unloading
        // throws INACTIVE_EFFECT instead of leaking.
        pluginCtx.effect(() => teardown);
        await applyGate;
      },
    });

    releaseApply?.();
    await fiber.await();
    await fiber.dispose();

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('disposing the container tears down a pending (never-applied) plugin', async () => {
    const ctx = new Context();
    const applied = vi.fn();
    const fiber = ctx.plugin({
      name: 'never-satisfied',
      inject: ['store'],
      apply: applied,
    });

    await ctx.fiber.dispose();

    expect(fiber.state).toBe(FiberState.DISPOSED);
    expect(isDisposed(fiber)).toBe(true);

    // Providing the dependency afterwards must not bring it back.
    ctx.provide('store', { records: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applied).not.toHaveBeenCalled();
  });
});
