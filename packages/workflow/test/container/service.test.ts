import { describe, it, expect } from 'vitest';
import { createServiceRegistry, ServiceNotFoundError } from '../../src/container/index.js';

interface TestServices {
  store: { name: string };
  logger: { level: string };
}

describe('ServiceRegistry', () => {
  it('get/has/provide round-trip', () => {
    const registry = createServiceRegistry<TestServices>();
    expect(registry.has('store')).toBe(false);
    expect(registry.get('store')).toBeUndefined();

    const store = { name: 'arc' };
    registry.provide('store', store);

    expect(registry.has('store')).toBe(true);
    expect(registry.get('store')).toBe(store);
    expect(registry.keys()).toEqual(['store']);
  });

  it('require() returns the value when present', () => {
    const registry = createServiceRegistry<TestServices>();
    registry.provide('logger', { level: 'info' });
    expect(registry.require('logger')).toEqual({ level: 'info' });
  });

  it('require() throws ServiceNotFoundError listing known keys when absent', () => {
    const registry = createServiceRegistry<TestServices>();
    registry.provide('logger', { level: 'info' });

    let caught: unknown;
    try {
      registry.require('store');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceNotFoundError);
    expect((caught as ServiceNotFoundError).key).toBe('store');
    expect((caught as ServiceNotFoundError).message).toContain('store');
    expect((caught as ServiceNotFoundError).message).toContain('logger');
  });

  it('provide() returns a disposer that withdraws the registration', () => {
    const registry = createServiceRegistry<TestServices>();
    const dispose = registry.provide('store', { name: 'arc' });

    dispose();

    expect(registry.has('store')).toBe(false);
    expect(registry.get('store')).toBeUndefined();
  });

  it("a stale disposer never clobbers a newer registration for the same key", () => {
    const registry = createServiceRegistry<TestServices>();
    const disposeFirst = registry.provide('store', { name: 'first' });
    registry.provide('store', { name: 'second' });

    // Disposing the FIRST registration must not remove the second, current
    // one — it only clears the registry if it still holds the value it
    // itself registered.
    disposeFirst();

    expect(registry.has('store')).toBe(true);
    expect(registry.get('store')).toEqual({ name: 'second' });
  });

  it('emits provide/revoke on the changes dispatcher', () => {
    const registry = createServiceRegistry<TestServices>();
    const events: string[] = [];
    registry.changes.on('provide', (key) => events.push(`provide:${String(key)}`));
    registry.changes.on('revoke', (key) => events.push(`revoke:${String(key)}`));

    const dispose = registry.provide('store', { name: 'arc' });
    dispose();

    expect(events).toEqual(['provide:store', 'revoke:store']);
  });

  it('a disposed-then-reprovided key does not fire a spurious revoke from the stale disposer', () => {
    const registry = createServiceRegistry<TestServices>();
    const events: string[] = [];
    registry.changes.on('provide', (key) => events.push(`provide:${String(key)}`));
    registry.changes.on('revoke', (key) => events.push(`revoke:${String(key)}`));

    const disposeFirst = registry.provide('store', { name: 'first' });
    registry.provide('store', { name: 'second' });
    disposeFirst();

    expect(events).toEqual(['provide:store', 'provide:store']);
  });
});
