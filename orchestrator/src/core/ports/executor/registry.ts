/**
 * Executor registry — the open, runtime-registrable set of `Executor` Port
 * implementations, mirroring `../verifier/registry.ts` and
 * `../code-index/registry.ts` on top of `@mars/workflow`'s keyed service
 * registry (`require()` throws naming every registered kind instead of
 * returning `undefined`; the returned disposer lets a test — or a future
 * out-of-process binding — withdraw a registration again).
 *
 * `local` self-registers at the bottom of this module as a side effect of
 * importing it — the same "built-ins self-register at import time" shape the
 * verifier and provider registries use. The active implementation is selected
 * via `resolvePortKind('executor', env)` (`../../config/registry.ts`'s shared
 * Port catalog, `MARS_EXECUTOR_KIND`, default `'local'`) and wired through
 * {@link resolveExecutor} below.
 *
 * This module is the ONE place a caller reaches to run an agent. Swapping the
 * execution backend (a sandboxed runner, a remote dispatcher) is therefore a
 * single `registerExecutor` call plus an env selection, not an edit at every
 * call site — which is exactly what the `executor-port-only` rule in
 * `.dependency-cruiser.cjs` keeps true (ADR-0097).
 */
import { createServiceRegistry, type Disposer } from '@mars/workflow'
import { resolvePortKind } from '../../config/registry'
import { localSubprocessExecutor } from './local-subprocess'
import type { Executor } from './types'

const registry = createServiceRegistry<Record<string, Executor>>()

/** Register an `Executor` implementation. The `local` built-in self-registers below at import time. */
export const registerExecutor = (impl: Executor): Disposer => registry.provide(impl.kind, impl)

export const getExecutor = (kind: string): Executor | undefined => registry.get(kind)

/** Like {@link getExecutor}, but throws naming every registered kind instead of returning `undefined`. */
export const requireExecutor = (kind: string): Executor => {
  if (!registry.has(kind)) {
    const known = listExecutors()
      .map((impl) => impl.kind)
      .sort()
      .join(', ')
    throw new Error(
      `Unknown Executor implementation '${kind}' — known: ${known || '(none registered)'}`,
    )
  }
  return registry.require(kind)
}

export const listExecutors = (): readonly Executor[] =>
  registry.keys().map((kind) => registry.require(kind))

// Built-in self-registers at import time.
registerExecutor(localSubprocessExecutor)

/**
 * Resolves the active `Executor` implementation from `env` (typically
 * `process.env`) via the shared Port registry's `executor` entry — the
 * `MARS_EXECUTOR_KIND` env var when set to a registered kind, else the
 * declared default (`'local'`). Throws if `env` names a kind the shared
 * catalog does not declare (see `resolvePortKind`) or a kind with no
 * implementation registered here (see {@link requireExecutor}) — both are
 * misconfiguration, not a fallback case.
 */
export const resolveExecutor = (env: Record<string, string | undefined> = process.env): Executor =>
  requireExecutor(resolvePortKind('executor', env))
