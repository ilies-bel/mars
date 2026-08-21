/**
 * Verifier registry — the open, runtime-registrable set of `Verifier` Port
 * implementations, mirroring `../code-index/registry.ts` and
 * `../../workers/provider-registry.ts` on top of `@mars/workflow`'s keyed
 * service registry (`require()` throws naming every registered kind instead
 * of returning `undefined`; `changes` lets a future consumer react to a
 * registration without polling).
 *
 * `local` and `remote-http` both self-register at the bottom of this module
 * as a side effect of importing it — the same "built-ins self-register at
 * import time" shape `provider-registry.ts` documents for providers. The
 * active implementation is selected via `resolvePortKind('verifier', env)`
 * (`../../config/registry.ts`'s shared Port catalog, `MARS_VERIFIER_KIND`,
 * default `'local'`) and wired through {@link resolveVerifier} below.
 *
 * `review` (`review-verifier.ts`) self-registers the same way, but as a side
 * effect of importing *that* module instead of this one: `review-verifier.ts`
 * depends on the `review` workflow primitive, which itself resolves the
 * `local` kind through this registry for its gate-execution step, so this
 * module deliberately does not import `review-verifier.ts` — doing so would
 * be a cycle (registry → review-verifier → review → registry). `review` is
 * not env-selected (there is no "active review implementation" — a caller
 * that wants review-based verification already knows it, the same way a
 * `Reflector` caller already knows which of the four kinds it wants), so it
 * has no `resolveX()` counterpart here — only direct lookup via
 * {@link requireVerifier}/{@link getVerifier}.
 *
 * The registry itself is storage for structurally-unrelated request/result
 * shapes per kind (mirroring `../reflector/registry.ts`'s `ReflectorMap`), so
 * `VerifierMap` erases to `Verifier<any, any, any>` and every accessor below
 * takes explicit type parameters (defaulting to the `local` kind's shapes) to
 * hand the caller back a properly-typed `Verifier`.
 */
import { createServiceRegistry, type Disposer } from '@mars/workflow'
import { resolvePortKind } from '../../config/registry'
import { localSubprocessVerifier } from './local-subprocess'
import { remoteHttpVerifier } from './remote-http'
import type { Verifier, VerifierRunArgs, VerifierRunContext, VerifierRunResult } from './types'

// `any` here (not `unknown`) is a deliberate escape hatch: the registry is
// untyped storage for structurally-unrelated request/result/context shapes
// (the `local` gate-runner vs. the `review` workflow primitive), and every
// consumer re-asserts the concrete triple it wants via this module's generic
// accessors — the same shape `../reflector/registry.ts`'s `ReflectorMap` uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VerifierMap = Record<string, Verifier<any, any, any>>

const registry = createServiceRegistry<VerifierMap>()

/** Register a `Verifier` implementation. Built-ins self-register below (or, for `review`, in `review-verifier.ts`) at import time. */
export const registerVerifier = <TArgs, TResult, TContext>(
  impl: Verifier<TArgs, TResult, TContext>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Disposer => registry.provide(impl.kind, impl as Verifier<any, any, any>)

export const getVerifier = <
  TArgs = VerifierRunArgs,
  TResult = VerifierRunResult,
  TContext = VerifierRunContext,
>(
  kind: string,
): Verifier<TArgs, TResult, TContext> | undefined =>
  registry.get(kind) as Verifier<TArgs, TResult, TContext> | undefined

/** Like {@link getVerifier}, but throws naming every registered kind instead of returning `undefined`. */
export const requireVerifier = <
  TArgs = VerifierRunArgs,
  TResult = VerifierRunResult,
  TContext = VerifierRunContext,
>(
  kind: string,
): Verifier<TArgs, TResult, TContext> => {
  if (!registry.has(kind)) {
    const known = listVerifiers()
      .map((impl) => impl.kind)
      .sort()
      .join(', ')
    throw new Error(`Unknown Verifier implementation '${kind}' — known: ${known || '(none registered)'}`)
  }
  return registry.require(kind) as Verifier<TArgs, TResult, TContext>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const listVerifiers = (): readonly Verifier<any, any, any>[] =>
  registry.keys().map((kind) => registry.require(kind))

// Built-ins self-register at import time.
registerVerifier(localSubprocessVerifier)
registerVerifier(remoteHttpVerifier)

/**
 * Resolves the active `Verifier` implementation from `env` (typically
 * `process.env`) via the shared Port registry's `verifier` entry — the
 * `MARS_VERIFIER_KIND` env var when set to a registered kind, else the
 * declared default (`'local'`). Throws if `env` names a kind the shared
 * catalog does not declare (see `resolvePortKind`) or a kind with no
 * implementation registered here (see {@link requireVerifier}) — both are
 * misconfiguration, not a fallback case.
 */
export const resolveVerifier = (env: Record<string, string | undefined> = process.env): Verifier =>
  requireVerifier(resolvePortKind('verifier', env))
