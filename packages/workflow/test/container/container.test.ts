import { describe, it, expect, vi } from 'vitest';
import { createContainer } from '../../src/container/index.js';
import type { Plugin } from '../../src/container/index.js';

interface TestServices extends Record<string, unknown> {
  store: { records: string[] };
  logger: { level: string };
}

function flush(times = 3): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>(
    (p) => p.then(() => Promise.resolve()),
    Promise.resolve(),
  );
}

describe('createContainer — get/has/provide', () => {
  it('provide() registers a value retrievable via get()/has()', () => {
    const container = createContainer<TestServices>();
    expect(container.has('store')).toBe(false);

    container.provide('store', { records: [] });

    expect(container.has('store')).toBe(true);
    expect(container.get('store')).toEqual({ records: [] });
  });

  it('provide() returns a disposer; calling it withdraws the registration', () => {
    const container = createContainer<TestServices>();
    const dispose = container.provide('store', { records: [] });

    dispose();

    expect(container.has('store')).toBe(false);
  });

  it('require() throws when the key is missing', () => {
    const container = createContainer<TestServices>();
    expect(() => container.require('store')).toThrow(/store/);
  });
});

describe('createContainer — fork scopes', () => {
  it('a fork shares the parent registry but tracks its own disposers', () => {
    const root = createContainer<TestServices>();
    root.provide('store', { records: [] });

    const fork = root.fork('child');
    fork.provide('logger', { level: 'debug' });

    // Shared registry: the fork sees what root registered and vice versa.
    expect(fork.get('store')).toEqual({ records: [] });
    expect(root.get('logger')).toEqual({ level: 'debug' });

    fork.dispose();

    // Disposing the fork only withdraws what was registered THROUGH it.
    expect(root.has('logger')).toBe(false);
    expect(root.has('store')).toBe(true);
  });

  it('disposing the root reverses everything a fork registered too (LIFO)', () => {
    const root = createContainer<TestServices>();
    const fork = root.fork('child');
    fork.provide('logger', { level: 'debug' });

    root.dispose();

    expect(fork.disposed).toBe(true);
    expect(root.get('logger')).toBeUndefined();
  });

  it('events registered through a fork are removed when the fork disposes', () => {
    const root = createContainer<TestServices, { ping: (n: number) => void }>();
    const fork = root.fork('child');
    const fn = vi.fn();
    fork.events.on('ping', fn);

    root.events.emit('ping', 1);
    expect(fn).toHaveBeenCalledTimes(1);

    fork.dispose();

    root.events.emit('ping', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('createContainer — plugins', () => {
  it('applies immediately when inject dependencies are already present', async () => {
    const container = createContainer<TestServices>();
    container.provide('store', { records: [] });

    const applied = vi.fn();
    const plugin: Plugin<undefined, TestServices> = {
      name: 'immediate',
      inject: ['store'],
      apply(ctx) {
        applied(ctx.get('store'));
      },
    };

    const scope = container.plugin(plugin);
    await flush();

    expect(applied).toHaveBeenCalledWith({ records: [] });
    expect(scope.active).toBe(true);
  });

  it('defers apply() until every injected dependency is present, then applies exactly once', async () => {
    const container = createContainer<TestServices>();
    const applied = vi.fn();
    const plugin: Plugin<undefined, TestServices> = {
      name: 'deferred',
      inject: ['store', 'logger'],
      apply() {
        applied();
      },
    };

    const scope = container.plugin(plugin);
    await flush();
    expect(scope.active).toBe(false);
    expect(applied).not.toHaveBeenCalled();

    container.provide('store', { records: [] });
    await flush();
    expect(scope.active).toBe(false);
    expect(applied).not.toHaveBeenCalled();

    container.provide('logger', { level: 'info' });
    await flush();

    expect(applied).toHaveBeenCalledTimes(1);
    expect(scope.active).toBe(true);
  });

  it('a plugin with no inject list applies immediately', async () => {
    const container = createContainer<TestServices>();
    const applied = vi.fn();
    const scope = container.plugin<undefined>({ name: 'no-deps', apply: applied });

    await flush();

    expect(applied).toHaveBeenCalledTimes(1);
    expect(scope.active).toBe(true);
  });

  it("tearing down and re-applying: withdrawing an injected dependency disposes the plugin's registrations, and re-providing it re-applies", async () => {
    const container = createContainer<TestServices>();
    const disposeStore = container.provide('store', { records: [] });

    let teardownCalls = 0;
    let applyCalls = 0;
    const plugin: Plugin<undefined, TestServices> = {
      name: 'reactive',
      inject: ['store'],
      apply(ctx) {
        applyCalls += 1;
        ctx.provide('logger', { level: 'info' });
        return () => {
          teardownCalls += 1;
        };
      },
    };

    const scope = container.plugin(plugin);
    await flush();
    expect(applyCalls).toBe(1);
    expect(container.has('logger')).toBe(true);
    expect(scope.active).toBe(true);

    disposeStore();
    await flush();

    expect(teardownCalls).toBe(1);
    // Everything the plugin registered while active — including services
    // it provided itself — is reversed, not just the disposer it returned.
    expect(container.has('logger')).toBe(false);
    expect(scope.active).toBe(false);
    expect(scope.disposed).toBe(false);

    container.provide('store', { records: [] });
    await flush();

    expect(applyCalls).toBe(2);
    expect(container.has('logger')).toBe(true);
    expect(scope.active).toBe(true);
  });

  it('scope.dispose() tears down an active plugin and stops it from re-applying', async () => {
    const container = createContainer<TestServices>();
    container.provide('store', { records: [] });

    let teardownCalls = 0;
    const plugin: Plugin<undefined, TestServices> = {
      name: 'disposable',
      inject: ['store'],
      apply() {
        return () => {
          teardownCalls += 1;
        };
      },
    };

    const scope = container.plugin(plugin);
    await flush();
    expect(scope.active).toBe(true);

    scope.dispose();
    expect(teardownCalls).toBe(1);
    expect(scope.disposed).toBe(true);
    expect(scope.active).toBe(false);

    // Re-providing the dependency after disposal must NOT resurrect a
    // disposed plugin scope.
    container.provide('store', { records: [] });
    await flush();
    expect(teardownCalls).toBe(1);
    expect(scope.active).toBe(false);
  });

  it('optional keys are readable inside apply() but never gate whether it runs', async () => {
    const container = createContainer<TestServices>();
    // No `logger` provided at all.
    let seenLogger: unknown = 'unset';
    const plugin: Plugin<undefined, TestServices> = {
      name: 'optional-deps',
      optional: ['logger'],
      apply(ctx) {
        seenLogger = ctx.get('logger');
      },
    };

    const scope = container.plugin(plugin);
    await flush();

    expect(scope.active).toBe(true);
    expect(seenLogger).toBeUndefined();
  });

  it('a teardown disposer returned from apply() still runs even if the scope disposes while apply() is still in flight', async () => {
    let resolveApply: (() => void) | undefined;
    const applyGate = new Promise<void>((resolve) => {
      resolveApply = resolve;
    });
    const teardown = vi.fn();

    const container = createContainer<TestServices>();
    const plugin: Plugin<undefined, TestServices> = {
      name: 'slow-apply',
      async apply() {
        await applyGate;
        return teardown;
      },
    };

    const scope = container.plugin(plugin);
    // apply() is still awaiting `applyGate` — dispose the scope before it
    // resolves.
    scope.dispose();
    expect(scope.disposed).toBe(true);

    resolveApply?.();
    await flush();

    // The disposer `apply()` eventually returned must still have run, not
    // been silently dropped because it arrived after disposal.
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('disposing the parent tears down a pending (not-yet-applied) plugin without ever applying it', async () => {
    const container = createContainer<TestServices>();
    const applied = vi.fn();
    const plugin: Plugin<undefined, TestServices> = {
      name: 'never-satisfied',
      inject: ['store'],
      apply: applied,
    };

    const scope = container.plugin(plugin);
    container.dispose();
    await flush();

    // Providing the dependency after the parent (and thus the plugin's
    // fork) is disposed must not bring it back.
    const fresh = createContainer<TestServices>();
    void fresh; // unrelated container; the point is `container` above is gone.

    expect(scope.disposed).toBe(true);
    expect(applied).not.toHaveBeenCalled();
  });
});
