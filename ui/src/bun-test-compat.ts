/**
 * Compatibility shim so test files written for Bun's test runner (`bun:test`)
 * execute unchanged under `npx vitest run`.
 *
 * The alias `'bun:test': '@/bun-test-compat'` in vitest.config.ts redirects
 * all `import { … } from 'bun:test'` statements to this module at test time.
 *
 * Mapped APIs:
 * - `mock(fn?)`  → `vi.fn(fn?)` — creates a spy/mock function
 * - `spyOn`      → `vi.spyOn`   — spies on an object method
 * - All other exports (`describe`, `it`, `test`, `expect`, lifecycle hooks)
 *   are re-exported verbatim from vitest.
 */

import { vi } from 'vitest'

export {
  describe,
  it,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vitest'

/**
 * bun:test `mock(impl?)` compatibility wrapper.
 *
 * bun:test allows calling `mock(value)` with a non-function to create a mock
 * that returns that value when called. vitest's `vi.fn(impl)` requires `impl`
 * to be a function. This wrapper handles both cases:
 * - `mock(fn)` → `vi.fn(fn)`
 * - `mock(value)` → `vi.fn().mockReturnValue(value)`
 * - `mock.module(path, factory)` → `vi.mock(path, factory)`
 */
export const mock = Object.assign(
  (implOrReturn?: unknown) => {
    if (implOrReturn === undefined || typeof implOrReturn === 'function') {
      return vi.fn(implOrReturn as ((...args: unknown[]) => unknown) | undefined)
    }
    return vi.fn().mockReturnValue(implOrReturn)
  },
  { module: vi.mock.bind(vi) as typeof vi.mock },
)

// bun:test `spyOn(obj, method)` → vitest `vi.spyOn(obj, method)`
export const spyOn = vi.spyOn.bind(vi) as typeof vi.spyOn
