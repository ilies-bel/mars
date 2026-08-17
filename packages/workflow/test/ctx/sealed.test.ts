import { describe, it, expect } from 'vitest';
import {
  createRunContainer,
  isSealedName,
  readService,
  sealService,
  SEALED_SERVICE_KEYS,
  Context,
} from '../../src/ctx/index.js';

/**
 * ADR-0052 — the Arc write funnel is non-bypassable. These are the assertions
 * that keep it that way at the container level: no plugin, and no workflow
 * body, may install or replace the object task-state writes go through.
 */
describe('sealed services', () => {
  it('names both sealed services', () => {
    expect([...SEALED_SERVICE_KEYS]).toEqual(['store', 'traceStore']);
    expect(isSealedName('store')).toBe(true);
    expect(isSealedName('traceStore')).toBe(true);
    expect(isSealedName('agent')).toBe(false);
  });

  it('is readable through the Mars read path and as a plain context property', () => {
    const store = { name: 'arc' };
    const ctx = createRunContainer({ services: { store } });

    expect(readService(ctx, 'store')).toBe(store);
    expect(ctx.store).toBe(store);
  });

  it('ctx.provide("store", fake) throws', () => {
    const ctx = createRunContainer({ services: { store: { name: 'arc' } } });

    expect(() => ctx.provide('store', { name: 'fake' })).toThrow(/already declared as accessor/);
    expect(() => ctx.provide('traceStore', { name: 'fake' })).toThrow(
      /already declared as accessor/,
    );
    expect(ctx.store).toEqual({ name: 'arc' });
  });

  it('is sealed even when the host injected no store at all', () => {
    // The invariant is "a workflow can never INSTALL a task-state store", not
    // "can never replace the one that happens to be there".
    const ctx = createRunContainer();

    expect(() => ctx.provide('store', { name: 'fake' })).toThrow(/already declared as accessor/);
    expect(readService(ctx, 'store')).toBeUndefined();
  });

  it('ctx.accessor("store", …) cannot re-declare it either', () => {
    const ctx = createRunContainer({ services: { store: { name: 'arc' } } });

    expect(() => sealService(ctx, 'store', { name: 'fake' })).toThrow(
      /already declared as accessor/,
    );
  });

  it('ctx.set("store", fake) throws — there is no providing fiber to set through', () => {
    const ctx = createRunContainer({ services: { store: { name: 'arc' } } });

    expect(() => ctx.set('store', { name: 'fake' })).toThrow(/without provide/);
  });

  it('assigning ctx.store throws: the accessor has no set hook', () => {
    const ctx = createRunContainer({ services: { store: { name: 'arc' } } });

    expect(() => {
      ctx.store = { name: 'fake' };
    }).toThrow(TypeError);
    expect(ctx.store).toEqual({ name: 'arc' });
  });

  it('THE ISOLATION HOLE IS CLOSED: ctx.isolate("store", …) cannot shadow it', () => {
    // This is the whole reason the seal is an accessor rather than a `provide`
    // from the root fiber. `isolate` opens a fresh scope label in which an
    // ordinary service name is free again — but accessors live in the flat,
    // shared reflect.props map, which isolation does not key on.
    const ctx = createRunContainer({ services: { store: { name: 'arc' } } });

    const isolated = ctx.isolate('store');
    expect(() => isolated.provide('store', { name: 'fake' })).toThrow(
      /already declared as accessor/,
    );
    expect(isolated.store).toEqual({ name: 'arc' });
  });

  it('an ordinary service IS shadowable by isolate — the contrast that makes the point', () => {
    const ctx = createRunContainer({ services: { agent: { name: 'claude' } } });

    const isolated = ctx.isolate('agent');
    isolated.provide('agent', { name: 'swapped' });

    expect(isolated.get('agent')).toEqual({ name: 'swapped' });
    expect(ctx.get('agent')).toEqual({ name: 'claude' });
  });

  it('RESIDUAL RISK, PINNED: ctx.extend({store}) shadows locally and cannot reach the shell', () => {
    // Own properties always shadow in a prototype chain, so a plugin can give
    // ITSELF a fake `ctx.store`. That is harmless by construction: the
    // framework-owned shell writes through the services bag captured at
    // composition time, never through a plugin's context.
    const realStore = { writes: [] as string[] };
    const services = { store: realStore };
    const ctx = createRunContainer({ services });

    const fakeStore = { writes: [] as string[] };
    const rogue = ctx.extend({ store: fakeStore });
    expect(rogue.store).toBe(fakeStore);

    // The shell — modelled here as a function closing over the composition-time
    // services bag, exactly as `orchestrator/src/tools/*` does.
    const shellWrite = (message: string): void => {
      services.store.writes.push(message);
    };
    shellWrite('task-state');

    expect(realStore.writes).toEqual(['task-state']);
    expect(fakeStore.writes).toEqual([]);
    // And the parent context is untouched.
    expect(ctx.store).toBe(realStore);
  });

  it('a plugin fiber sees the sealed value and still cannot replace it', async () => {
    const store = { name: 'arc' };
    const ctx = createRunContainer({ services: { store } });
    let seen: unknown;
    let provideError: unknown;

    const fiber = await ctx.plugin({
      name: 'nosy',
      apply(pluginCtx) {
        seen = pluginCtx.store;
        try {
          pluginCtx.provide('store', { name: 'fake' });
        } catch (error) {
          provideError = error;
        }
      },
    });

    expect(fiber.state).toBe(2 /* ACTIVE */);
    expect(seen).toBe(store);
    expect((provideError as Error).message).toMatch(/already declared as accessor/);
  });

  it('sealService is generic — it seals any name, once', () => {
    const ctx = new Context();
    sealService(ctx, 'frozen', 42);

    expect(readService(ctx, 'frozen')).toBe(42);
    expect(() => ctx.provide('frozen', 43)).toThrow(/already declared as accessor/);
  });
});
