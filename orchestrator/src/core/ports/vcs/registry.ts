/**
 * Vcs registry — the open, runtime-registrable set of `Vcs` Port
 * implementations, mirroring `../code-index/registry.ts`'s pattern on top of
 * `@mars/workflow`'s keyed service registry (`require()` throws naming every
 * registered kind instead of returning `undefined`; `changes` lets a future
 * consumer react to a registration without polling).
 *
 * The built-in `local-git` is registered lazily on first lookup (see
 * `ensureBuiltinsRegistered`), so importing the registry is enough to make
 * `resolveVcs()` answer without depending on module evaluation order in the
 * registry <-> local-git <-> lib/git/checkpoint import cycle.
 *
 * The active implementation is selected via `resolvePortKind('vcs', env)`
 * (`../../config/registry.ts`'s shared Port catalog, `MARS_VCS_KIND`, default
 * `'local-git'`) and wired through {@link resolveVcs} below.
 */
import { createServiceRegistry, type Disposer } from '@mars/workflow'
import { resolvePortKind } from '../../config/registry'
import { localGitVcs } from './local-git'
import type { Vcs } from './types'

type VcsMap = Record<string, Vcs>

const registry = createServiceRegistry<VcsMap>()

/**
 * Built-ins are registered lazily on first lookup, never at module scope:
 * `./local-git` reaches `lib/git/checkpoint`, which imports this registry, so
 * a module-scope `registerVcs(localGitVcs)` ran while `localGitVcs` was still
 * undefined whenever a fresh module graph (e.g. after `vi.resetModules()`)
 * entered through a different root. By lookup time every module has finished
 * evaluating. Idempotent, and never overrides a kind registered explicitly.
 */
const ensureBuiltinsRegistered = (): void => {
  if (!registry.has(localGitVcs.kind)) registry.provide(localGitVcs.kind, localGitVcs)
}

/** Register a `Vcs` implementation. */
export const registerVcs = (impl: Vcs): Disposer => registry.provide(impl.kind, impl)

export const getVcs = (kind: string): Vcs | undefined => {
  ensureBuiltinsRegistered()
  return registry.get(kind)
}

/** Like {@link getVcs}, but throws naming every registered kind instead of returning `undefined`. */
export const requireVcs = (kind: string): Vcs => {
  ensureBuiltinsRegistered()
  if (!registry.has(kind)) {
    const known = listVcses()
      .map((impl) => impl.kind)
      .sort()
      .join(', ')
    throw new Error(`Unknown Vcs implementation '${kind}' — known: ${known || '(none registered)'}`)
  }
  return registry.require(kind)
}

export const listVcses = (): readonly Vcs[] => {
  ensureBuiltinsRegistered()
  return registry.keys().map((kind) => registry.require(kind))
}

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
