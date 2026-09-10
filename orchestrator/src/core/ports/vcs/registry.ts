/**
 * Vcs registry — the open, runtime-registrable set of `Vcs` Port
 * implementations, mirroring `../code-index/registry.ts`'s pattern on top of
 * `@mars/workflow`'s keyed service registry (`require()` throws naming every
 * registered kind instead of returning `undefined`; `changes` lets a future
 * consumer react to a registration without polling).
 *
 * `local-git` self-registers at the bottom of `./local-git.ts` so the
 * module-level initialization order is deterministic. This file deliberately
 * does NOT import `./local-git` directly: `local-git.ts` imports
 * `../../lib/git/checkpoint`, which imports this registry, which would create
 * a circular dependency that leaves `localGitVcs` undefined at register time.
 * Moving the registration call into `local-git.ts` (at the end, after
 * `localGitVcs` is fully constructed) avoids the cycle while preserving the
 * "built-ins self-register at import time" semantics.
 *
 * The active implementation is selected via `resolvePortKind('vcs', env)`
 * (`../../config/registry.ts`'s shared Port catalog, `MARS_VCS_KIND`, default
 * `'local-git'`) and wired through {@link resolveVcs} below.
 */
import { createServiceRegistry, type Disposer } from '@mars/workflow'
import { resolvePortKind } from '../../config/registry'
import type { Vcs } from './types'

type VcsMap = Record<string, Vcs>

const registry = createServiceRegistry<VcsMap>()

/** Register a `Vcs` implementation. Built-ins self-register in their own file. */
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
