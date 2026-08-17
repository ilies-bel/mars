import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { FiberState, fiberStateName, isActive, isDisposed } from '../../src/ctx/fiber-state.js';
import { Context } from '@deepseek-ai/cordis';

const require_ = createRequire(import.meta.url);
const cordisRoot = dirname(require_.resolve('@deepseek-ai/cordis/package.json'));

/** Parse `export declare const enum FiberState { … }` out of the shipped d.ts. */
function shippedFiberState(): Record<string, number> {
  const dts = readFileSync(resolve(cordisRoot, 'lib/types/fiber.d.ts'), 'utf8');
  const block = /export declare const enum FiberState \{([^}]*)\}/.exec(dts);
  if (!block) throw new Error('FiberState enum not found in cordis fiber.d.ts');
  const out: Record<string, number> = {};
  for (const line of block[1].split('\n')) {
    const member = /^\s*([A-Z_]+)\s*=\s*(\d+)\s*,?\s*$/.exec(line);
    if (member) out[member[1]] = Number(member[2]);
  }
  return out;
}

describe('FiberState mirror', () => {
  it('cordis does NOT export FiberState at runtime — it is a const enum, type-only', async () => {
    // The reason this mirror exists. `import { FiberState } from '@deepseek-ai/cordis'`
    // typechecks and then blows up at the first property read.
    const cordis: Record<string, unknown> = await import('@deepseek-ai/cordis');
    expect(cordis.FiberState).toBeUndefined();
    expect(Object.keys(cordis)).toContain('Context');
  });

  it('the Mars mirror matches the const enum cordis ships', () => {
    expect({ ...FiberState }).toEqual(shippedFiberState());
  });

  it('is frozen, so nothing can renumber it at runtime', () => {
    expect(Object.isFrozen(FiberState)).toBe(true);
  });

  it('fiberStateName names every member', () => {
    expect(fiberStateName(FiberState.PENDING)).toBe('PENDING');
    expect(fiberStateName(FiberState.ACTIVE)).toBe('ACTIVE');
    expect(fiberStateName(FiberState.DISPOSED)).toBe('DISPOSED');
    expect(fiberStateName(99 as FiberState)).toBe('UNKNOWN(99)');
  });

  it('isActive/isDisposed read a live root fiber', () => {
    const ctx = new Context();
    expect(ctx.fiber.state).toBe(FiberState.ACTIVE);
    expect(isActive(ctx.fiber)).toBe(true);
    expect(isDisposed(ctx.fiber)).toBe(false);
  });
});
