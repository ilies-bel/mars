/**
 * Reflector registry — the open, runtime-registrable set of `Reflector` Port
 * implementations, mirroring `../code-index/registry.ts`'s pattern on top of
 * `@mars/workflow`'s keyed service registry.
 *
 * Unlike CodeIndex (N interchangeable implementations of ONE contract,
 * selected at runtime by an env var), each `ReflectorKind` here is a
 * DISTINCT contract with its own request/result shape — a call site already
 * knows which kind it wants (`token`, `deep-arc`, `deep-session`,
 * `failure`), so there is no env-driven "resolve the active implementation"
 * step, only lookup by kind (see {@link requireReflector}).
 *
 * The four built-ins self-register at the bottom of this module as a side
 * effect of importing it: `tokenReflector` (`../../lib/reflector.ts`),
 * `deepArcReflector`/`deepSessionReflector` (`../../lib/deep-reflector.ts`),
 * and `failureReflector` (`../../lib/failure-reflector.ts`).
 */
import { createServiceRegistry, type Disposer } from '@mars/workflow'
import type { Reflector, ReflectorKind, ReflectorRunOutcome } from './types'
import { tokenReflector } from '../../lib/reflector'
import { deepArcReflector, deepSessionReflector } from '../../lib/deep-reflector'
import { failureReflector } from '../../lib/failure-reflector'

// `any` here (not `unknown`) is a deliberate escape hatch: the registry
// itself is untyped storage for four structurally-unrelated request/result
// shapes, and every consumer re-asserts the concrete pair it wants via
// {@link requireReflector}'s type parameters — the same shape as
// `ServiceRegistry`'s own `M[K]` indexing, just without a single shared `M`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReflectorMap = Record<string, Reflector<any, any>>

const registry = createServiceRegistry<ReflectorMap>()

/** Register a `Reflector` implementation. Built-ins self-register below at import time. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const registerReflector = (impl: Reflector<any, any>): Disposer => registry.provide(impl.kind, impl)

export const getReflector = <TRequest, TResult extends ReflectorRunOutcome>(
  kind: ReflectorKind,
): Reflector<TRequest, TResult> | undefined =>
  registry.get(kind) as Reflector<TRequest, TResult> | undefined

/** Like {@link getReflector}, but throws naming every registered kind instead of returning `undefined`. */
export const requireReflector = <TRequest, TResult extends ReflectorRunOutcome>(
  kind: ReflectorKind,
): Reflector<TRequest, TResult> => {
  if (!registry.has(kind)) {
    const known = listReflectors()
      .map((impl) => impl.kind)
      .sort()
      .join(', ')
    throw new Error(`Unknown Reflector implementation '${kind}' — known: ${known || '(none registered)'}`)
  }
  return registry.require(kind) as Reflector<TRequest, TResult>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const listReflectors = (): readonly Reflector<any, any>[] =>
  registry.keys().map((kind) => registry.require(kind))

// Built-ins self-register at import time.
registerReflector(tokenReflector)
registerReflector(deepArcReflector)
registerReflector(deepSessionReflector)
registerReflector(failureReflector)
