/**
 * CodeIndex registry — the open, runtime-registrable set of `CodeIndex` Port
 * implementations, mirroring `../../workers/provider-registry.ts`'s pattern
 * on top of `@mars/workflow`'s keyed service registry (`require()` throws
 * naming every registered kind instead of returning `undefined`; `changes`
 * lets a future consumer react to a registration without polling).
 *
 * `none` and `codegraph` self-register at the bottom of this module as a
 * side effect of importing it — the same "built-ins self-register at import
 * time" shape `provider-registry.ts` documents for providers. The active
 * implementation is selected via `resolvePortKind('codeIndex', env)`
 * (`../../config/registry.ts`'s shared Port catalog, `MARS_CODE_INDEX_KIND`,
 * default `'none'`) and wired through {@link resolveCodeIndex} below.
 */
import { createServiceRegistry, type Disposer } from '@mars/workflow'
import { resolvePortKind } from '../../config/registry'
import { codegraphCodeIndex } from './codegraph'
import { noneCodeIndex } from './none'
import type { CodeIndex } from './types'

type CodeIndexMap = Record<string, CodeIndex>

const registry = createServiceRegistry<CodeIndexMap>()

/** Register a `CodeIndex` implementation. Built-ins self-register below at import time. */
export const registerCodeIndex = (impl: CodeIndex): Disposer => registry.provide(impl.kind, impl)

export const getCodeIndex = (kind: string): CodeIndex | undefined => registry.get(kind)

/** Like {@link getCodeIndex}, but throws naming every registered kind instead of returning `undefined`. */
export const requireCodeIndex = (kind: string): CodeIndex => {
  if (!registry.has(kind)) {
    const known = listCodeIndexes()
      .map((impl) => impl.kind)
      .sort()
      .join(', ')
    throw new Error(`Unknown CodeIndex implementation '${kind}' — known: ${known || '(none registered)'}`)
  }
  return registry.require(kind)
}

export const listCodeIndexes = (): readonly CodeIndex[] => registry.keys().map((kind) => registry.require(kind))

// Built-ins self-register at import time.
registerCodeIndex(noneCodeIndex)
registerCodeIndex(codegraphCodeIndex)

/**
 * Resolves the active `CodeIndex` implementation from `env` (typically
 * `process.env`) via the shared Port registry's `codeIndex` entry — the
 * `MARS_CODE_INDEX_KIND` env var when set to a registered kind, else the
 * declared default (`'none'`). Throws if `env` names an unregistered kind
 * (see `resolvePortKind`) or if the resolved kind has no matching
 * implementation registered here (see {@link requireCodeIndex}) — both are
 * misconfiguration, not a fallback case.
 */
export const resolveCodeIndex = (env: Record<string, string | undefined> = process.env): CodeIndex =>
  requireCodeIndex(resolvePortKind('codeIndex', env))
