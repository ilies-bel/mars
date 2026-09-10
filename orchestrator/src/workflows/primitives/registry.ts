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
  /** Alternate ids that resolve to the same primitive (e.g. `'review'` for `'verify'`). */
  readonly aliases?: readonly string[]
  readonly executor: 'agent' | 'deterministic' | 'human'
  /**
   * One-line description surfaced by GET /view/primitives. Primitives with a
   * description are included in the public listing; those without are treated
   * as internal and omitted from `viewPrimitives()` output.
   */
  readonly description?: string
  /**
   * Trace phase this primitive's Step spans carry. Null for awaitHuman — it
   * parks before any span opens and so never appears in step_started/step_ended.
   * Absent for custom primitives that have not been assigned a phase yet.
   */
  readonly phase?: string | null
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
// `verify`/`review` are the same primitive: `verify` is the canonical public id
// (used in the UI and catalog); `review` is its exported function name and a
// registered alias so both `isPrimitiveId('verify')` and `isPrimitiveId('review')`
// return true and workflow-lint allows `import { review } from 'mars/workflow'`.
//
// Primitives with a `description` appear in GET /view/primitives (the public
// listing). `finalizeReport` and `finalizeMockup` are internal — no description,
// not surfaced in the listing.
registerPrimitive({
  id: 'setupWorktree',
  exportName: 'setupWorktree',
  executor: 'deterministic',
  description:
    'Provision (or attach to) the task worktree off the integration branch, record the integration HEAD, and install its deps.',
  phase: 'setup',
})
registerPrimitive({
  id: 'runAgent',
  exportName: 'runAgent',
  executor: 'agent',
  description:
    'Run the coder through the selected headless provider inside the worktree — kind-aware Worker routing: Coder by default, Fixer on kind:fix, plus tag-routed operator-declared Workers.',
  phase: 'code',
})
registerPrimitive({
  id: 'verify',
  exportName: 'review',
  aliases: ['review'],
  executor: 'deterministic',
  description:
    "Full-workspace static gate over the worktree's committed changes — every configured typecheck, test, and lint scope runs to protect cross-package contracts.",
  phase: 'verify',
})
registerPrimitive({
  id: 'behaviourVerify',
  executor: 'agent',
  description:
    "Behaviour verification gate — boots the task's preview dev server and dispatches the BehaviourVerifier Worker (Playwright MCP, read-only) against the task's Definition of Done.",
  phase: 'verify',
})
registerPrimitive({
  id: 'merge',
  exportName: 'merge',
  executor: 'deterministic',
  description:
    'Fast-forward the task branch into the integration branch, serialized under the merge lock; removes the worktree and marks the task done on success.',
  phase: 'merge',
})
registerPrimitive({
  id: 'awaitHuman',
  exportName: 'awaitHuman',
  executor: 'human',
  description:
    "Park the task awaiting-human until the operator finishes the step (`mars step done`) — it writes task state and raises an action-queue row; nothing executes.",
  phase: null,
})
// Internal pipeline steps — no description, not included in the public listing.
registerPrimitive({ id: 'finalizeReport', executor: 'deterministic' })
registerPrimitive({ id: 'finalizeMockup', executor: 'deterministic' })
