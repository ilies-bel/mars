import { describe, it, expect } from 'vitest';
import { Context, createRunContainer, disposeRunContainer, readService, ReservedServiceNameError } from '../../src/ctx/index.js';
import './test-events.js';

describe('Context — get/provide', () => {
  it('provide() registers a value retrievable via get()', () => {
    const ctx = new Context();
    expect(ctx.get('db')).toBeUndefined();

    ctx.provide('db', { records: [] });

    expect(ctx.get('db')).toEqual({ records: [] });
  });

  it('provide() returns a disposer; calling it withdraws the registration', () => {
    const ctx = new Context();
    const dispose = ctx.provide('db', { records: [] });

    dispose();

    expect(ctx.get('db')).toBeUndefined();
  });

  it('provide() throws on a duplicate name — the native container silently overwrote', () => {
    const ctx = new Context();
    ctx.provide('db', { records: [] });

    expect(() => ctx.provide('db', { records: ['other'] })).toThrow(/has been registered/);
  });

  it('there is no has(): a missing key reads as undefined', () => {
    const ctx = new Context();
    expect(ctx.get('nothing')).toBeUndefined();
    ctx.provide('nothing', 0);
    // 0 is a legitimate value, so `get(k) !== undefined` is the has() replacement.
    expect(ctx.get('nothing')).toBe(0);
  });
});

describe('createRunContainer — seeding from a services bag', () => {
  it('seeds one registration per own enumerable property', () => {
    const services = { git: { name: 'git' }, agent: { name: 'agent' } };
    const ctx = createRunContainer({ services });

    expect(ctx.get('git')).toBe(services.git);
    expect(ctx.get('agent')).toBe(services.agent);
  });

  it('a service value is handed back by identity, not wrapped in a tracing proxy', () => {
    const store = { name: 'arc' };
    const ctx = createRunContainer({ services: { store } });

    expect(readService(ctx, 'store')).toBe(store);
  });

  it('rejects a service name the container reserves for its own API', () => {
    expect(() => createRunContainer({ services: { emit: () => {} } })).toThrow(
      ReservedServiceNameError,
    );
    expect(() => createRunContainer({ services: { plugin: {} } })).toThrow(/reserved/);
  });

  it('tolerates a missing / non-object services bag', () => {
    expect(() => createRunContainer()).not.toThrow();
    expect(() => createRunContainer({ services: undefined })).not.toThrow();
  });

  it('routes cordis-reported failures (a throwing plugin) to onError', async () => {
    const errors: unknown[] = [];
    const ctx = createRunContainer({ onError: (error) => errors.push(error) });

    const fiber = ctx.plugin({
      name: 'explodes',
      apply() {
        throw new Error('apply exploded');
      },
    });
    await expect(fiber.await()).rejects.toThrow('apply exploded');

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('apply exploded');
  });
});

describe('disposeRunContainer', () => {
  it('reverses every registration made through the container', async () => {
    const ctx = createRunContainer({ services: { git: {} } });
    ctx.provide('extra', { added: true });

    await disposeRunContainer(ctx);

    expect(ctx.get('extra')).toBeUndefined();
    expect(ctx.get('git')).toBeUndefined();
  });

  it('runs disposers in reverse registration order', async () => {
    const order: string[] = [];
    const ctx = createRunContainer();
    ctx.effect(() => () => order.push('first'));
    ctx.effect(() => () => order.push('second'));

    await disposeRunContainer(ctx);

    expect(order).toEqual(['second', 'first']);
  });

  it('never throws out of teardown — a throwing disposer is reported instead', async () => {
    const errors: unknown[] = [];
    const ctx = createRunContainer({ onError: (error) => errors.push(error) });
    const seen: string[] = [];
    ctx.effect(() => () => seen.push('survivor'));
    ctx.effect(() => () => {
      throw new Error('teardown boom');
    });

    await expect(disposeRunContainer(ctx, (error) => errors.push(error))).resolves.toBeUndefined();

    expect(seen).toEqual(['survivor']);
    expect(errors.some((error) => (error as Error)?.message === 'teardown boom')).toBe(true);
  });
});
