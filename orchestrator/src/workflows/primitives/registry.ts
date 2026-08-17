/**
 * Primitive registry — the open, introspectable set of primitives a
 * user-owned workflow (`.mars/workflows/*.js`, imported through `mars/
 * workflow`) may call. Replaces two closed unions that enumerated this same
 * set independently and had already drifted apart:
 *
 *   - `ValidateRecorderEntry.primitive` (this directory's `index.ts`) — the
 *     `mars workflow validate` dry-run's declared-primitive type;
 *   - `ALLOWED_IMPORT_BINDINGS` (`../workflow-lint.ts`) — the static lint's
 *     legal-import allowlist.
 *
 * Both now read this registry instead of hard-coding their own list, so the
 * two checks can no longer disagree about what a legal workflow may
 * import/call the way `PRIMITIVE_NAMES` (`core/lib/primitive-catalog.ts`) and
 * the old `ValidateRecorderEntry.primitive` union already had (documented in
 * the target architecture doc, §4.4).
 *
 * Built on `@mars/workflow`'s keyed service registry, same rationale as
 * `core/workers/provider-registry.ts` / `worker-registry.ts`.
 */

import { createServiceRegistry, type Disposer } from '@mars/workflow'

export interface PrimitiveDescriptor {
  /** Stable identifier — what `ValidateRecorderEntry.primitive` records. */
  readonly id: string
  /**
   * The named binding exported from the `mars/workflow` barrel that invokes
   * this primitive, when a self-authored workflow (ADR-0068) may import and
   * call it directly. Absent for primitives reachable only from the
   * bundled/scaffolded pipelines (`behaviourVerify`, `finalizeReport`,
   * `finalizeMockup` today) — those are NOT part of the authoring surface,
   * and so are never added to workflow-lint's allowlist.
   */
  readonly exportName?: string
  /** Alternate ids that resolve to the same primitive (e.g. `'verify'` → `review`). */
  readonly aliases?: readonly string[]
  readonly executor: 'agent' | 'deterministic' | 'human'
}

type PrimitiveMap = Record<string, PrimitiveDescriptor>

const registry = createServiceRegistry<PrimitiveMap>()

/** Register a primitive under its id and every alias. Built-ins self-register below. */
export const registerPrimitive = (descriptor: PrimitiveDescriptor): Disposer => {
  const disposers = [registry.provide(descriptor.id, descriptor)]
  for (const alias of descriptor.aliases ?? []) {
    disposers.push(registry.provide(alias, descriptor))
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export const getPrimitive = (id: string): PrimitiveDescriptor | undefined => registry.get(id)

/** True when `id` is a registered primitive id or alias. */
export const isPrimitiveId = (id: string): boolean => registry.has(id)

/** Every distinct registered primitive (deduplicated across aliases). */
export const listPrimitives = (): readonly PrimitiveDescriptor[] => {
  const seen = new Set<PrimitiveDescriptor>()
  for (const key of registry.keys()) {
    const descriptor = registry.get(key)
    if (descriptor !== undefined) seen.add(descriptor)
  }
  return [...seen]
}

// ---- built-in seeds (self-registering) -------------------------------------
// Mirrors the eight primitives the target architecture doc (§4.4) enumerates.
// `review`/`verify` are the same primitive under two names — `review` is
// canonical (the exported function name), `verify` is the legacy alias.
registerPrimitive({ id: 'setupWorktree', exportName: 'setupWorktree', executor: 'deterministic' })
registerPrimitive({ id: 'runAgent', exportName: 'runAgent', executor: 'agent' })
registerPrimitive({
  id: 'review',
  exportName: 'review',
  aliases: ['verify'],
  executor: 'deterministic',
})
registerPrimitive({ id: 'behaviourVerify', executor: 'agent' })
registerPrimitive({ id: 'merge', exportName: 'merge', executor: 'deterministic' })
registerPrimitive({ id: 'awaitHuman', exportName: 'awaitHuman', executor: 'human' })
registerPrimitive({ id: 'finalizeReport', executor: 'deterministic' })
registerPrimitive({ id: 'finalizeMockup', executor: 'deterministic' })
