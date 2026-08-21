/**
 * Verifier registry — the open, runtime-registrable set of `Verifier` Port
 * implementations, mirroring `../code-index/registry.ts` and
 * `../../workers/provider-registry.ts` on top of `@mars/workflow`'s keyed
 * service registry (`require()` throws naming every registered kind instead
 * of returning `undefined`; `changes` lets a future consumer react to a
 * registration without polling).
 *
 * `local` self-registers at the bottom of this module as a side effect of
 * importing it — the same "built-ins self-register at import time" shape
 * `provider-registry.ts` documents for providers. The active implementation
 * is selected via `resolvePortKind('verifier', env)`
 * (`../../config/registry.ts`'s shared Port catalog, `MARS_VERIFIER_KIND`,
 * default `'local'`) and wired through {@link resolveVerifier} below.
 */
import { createServiceRegistry, type Disposer } from '@mars/workflow'
import { resolvePortKind } from '../../config/registry'
import { localSubprocessVerifier } from './local-subprocess'
import type { Verifier } from './types'

type VerifierMap = Record<string, Verifier>

const registry = createServiceRegistry<VerifierMap>()

/** Register a `Verifier` implementation. Built-ins self-register below at import time. */
export const registerVerifier = (impl: Verifier): Disposer => registry.provide(impl.kind, impl)

export const getVerifier = (kind: string): Verifier | undefined => registry.get(kind)

/** Like {@link getVerifier}, but throws naming every registered kind instead of returning `undefined`. */
export const requireVerifier = (kind: string): Verifier => {
  if (!registry.has(kind)) {
    const known = listVerifiers()
      .map((impl) => impl.kind)
      .sort()
      .join(', ')
    throw new Error(`Unknown Verifier implementation '${kind}' — known: ${known || '(none registered)'}`)
  }
  return registry.require(kind)
}

export const listVerifiers = (): readonly Verifier[] => registry.keys().map((kind) => registry.require(kind))

// Built-ins self-register at import time.
registerVerifier(localSubprocessVerifier)

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
