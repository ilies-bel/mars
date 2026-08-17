import { describe, it, expect, vi } from 'vitest';
import { DisposerSet, once } from '../../src/container/index.js';

describe('DisposerSet', () => {
  it('runs disposers in reverse (LIFO) registration order', () => {
    const order: string[] = [];
    const set = new DisposerSet();
    set.add(() => order.push('a'));
    set.add(() => order.push('b'));
    set.add(() => order.push('c'));

    set.dispose();

    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('is idempotent: a second dispose() does not re-run disposers', () => {
    const fn = vi.fn();
    const set = new DisposerSet();
    set.add(fn);

    set.dispose();
    set.dispose();
    set.dispose();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exposes disposed and size', () => {
    const set = new DisposerSet();
    expect(set.disposed).toBe(false);
    set.add(() => {});
    set.add(() => {});
    expect(set.size).toBe(2);
    set.dispose();
    expect(set.disposed).toBe(true);
    expect(set.size).toBe(0);
  });

  it('a throwing disposer is reported via onError and does not stop the rest', () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    const set = new DisposerSet({ onError: (e) => errors.push(e) });
    set.add(() => order.push('first'));
    set.add(() => {
      throw new Error('boom');
    });
    set.add(() => order.push('third'));

    expect(() => set.dispose()).not.toThrow();

    expect(order).toEqual(['third', 'first']);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('a disposer added after dispose() runs immediately instead of being queued', () => {
    const set = new DisposerSet();
    set.dispose();

    const fn = vi.fn();
    set.add(fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(set.size).toBe(0);
  });

  it('disposing a parent disposes a nested child set first (children registered later)', () => {
    const order: string[] = [];
    const parent = new DisposerSet();
    parent.add(() => order.push('parent-first'));

    const child = new DisposerSet();
    child.add(() => order.push('child'));
    parent.add(() => child.dispose());

    parent.add(() => order.push('parent-last'));

    parent.dispose();

    // LIFO: 'parent-last' registered after the child hook runs first, then
    // the child hook disposes the child (which logs 'child'), then
    // 'parent-first'.
    expect(order).toEqual(['parent-last', 'child', 'parent-first']);
  });
});

describe('once', () => {
  it('wraps a disposer so repeated direct calls only run it once', () => {
    const fn = vi.fn();
    const disposer = once(fn);

    disposer();
    disposer();
    disposer();

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
