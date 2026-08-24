/**
 * Vcs registry — the open, runtime-registrable set of `Vcs` Port
 * implementations, mirroring `../code-index/registry.ts`'s pattern on top of
 * `@mars/workflow`'s keyed service registry (`require()` throws naming every
 * registered kind instead of returning `undefined`; `changes` lets a future
 * consumer react to a registration without polling).
 *
 * `local-git` self-registers at the bottom of this module as a side effect
 * of importing it — the same "built-ins self-register at import time" shape
 * `provider-registry.ts` documents for providers. The active implementation
 * is selected via `resolvePortKind('vcs', env)` (`../../config/registry.ts`'s
 * shared Port catalog, `MARS_VCS_KIND`, default `'local-git'`) and wired
 * through {@link resolveVcs} below.
 */
import { createServiceRegistry, type Disposer } from '@mars/workflow'
import { resolvePortKind } from '../../config/registry'
import { localGitVcs } from './local-git'
import type { Vcs } from './types'

type VcsMap = Record<string, Vcs>

const registry = createServiceRegistry<VcsMap>()

/** Register a `Vcs` implementation. Built-ins self-register below at import time. */
export const registerVcs = (impl: Vcs): Disposer => registry.provide(impl.kind, impl)

export const getVcs = (kind: string): Vcs | undefined => registry.get(kind)

/** Like {@link getVcs}, but throws naming every registered kind instead of returning `undefined`. */
export const requireVcs = (kind: string): Vcs => {
  if (!registry.has(kind)) {
    const known = listVcses()
      .map((impl) => impl.kind)
      .sort()
      .join(', ')
    throw new Error(`Unknown Vcs implementation '${kind}' — known: ${known || '(none registered)'}`)
  }
  return registry.require(kind)
}

export const listVcses = (): readonly Vcs[] => registry.keys().map((kind) => registry.require(kind))

// Built-ins self-register at import time.
registerVcs(localGitVcs)

/**
 * Resolves the active `Vcs` implementation from `env` (typically
 * `process.env`) via the shared Port registry's `vcs` entry — the
 * `MARS_VCS_KIND` env var when set to a registered kind, else the declared
 * default (`'local-git'`). Throws if `env` names an unregistered kind (see
 * `resolvePortKind`) or if the resolved kind has no matching implementation
 * registered here (see {@link requireVcs}) — both are misconfiguration, not
 * a fallback case.
 */
export const resolveVcs = (env: Record<string, string | undefined> = process.env): Vcs =>
  requireVcs(resolvePortKind('vcs', env))
