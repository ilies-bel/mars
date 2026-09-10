/**
 * Primitive entity types — wire mirrors of the daemon's
 * `GET /api/primitives/:name` contract (see PrimitiveDetail and friends in
 * orchestrator/src/core/daemon/http-server.ts), plus the pure step-span →
 * primitive mapping the Studio nodes use to link into the primitive facet.
 *
 * Glossary terms are binding here: "Authorization profile" (never
 * denylist/disallowed tools), "Step span" (never step run/record), "Worker"
 * (never slot).
 */

/**
 * The known built-in primitive names, in pipeline order. Used for the
 * sibling-nav and for route validation. This list does NOT bound what the API
 * returns — `viewPrimitives()` reads the live registry, so operator-registered
 * primitives also appear even if absent from this array.
 */
export const PRIMITIVE_NAMES = [
  'setupWorktree',
  'runAgent',
  'verify',
  'behaviourVerify',
  'merge',
  'awaitHuman',
] as const

/**
 * A primitive name. Widened to `string` so unknown (operator-registered)
 * primitives received from the API are assignable without casting. The closed
 * `PRIMITIVE_NAMES` array remains for sibling-nav and route-validation code
 * that still needs the fixed list.
 */
export type PrimitiveName = string

/** Identity of one primitive — name, one-liner, phase, and WHO executes it. */
export interface PrimitiveSummary {
  name: string
  description: string
  /** Trace phase its Step spans carry, or null (awaitHuman emits no spans). */
  phase: string | null
  executor: 'agent' | 'shell' | 'human'
}

/**
 * One Worker's Authorization profile — model, effort, permission mode, and
 * the forfeited tools (empty = full tool surface). 'registry' marks
 * operator-declared Workers from .mars/worker-registry.json.
 */
export interface PrimitiveWorkerProfile {
  workerName: string
  model: string
  effort: string
  permissionMode: string
  forfeitedTools: string[]
  source: 'built-in' | 'registry'
}

/** One shell tool observed for a deterministic primitive (empirical, from tool_invoked events). */
export interface PrimitiveObservedTool {
  tool: string
  count: number
  lastInvokedAt: string
}

/** One Step span in a primitive's run history (newest first). */
export interface PrimitiveRun {
  stepName: string
  workflowInstanceId: string
  outcome: string
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  taskId: string | null
  originId: string | null
  workerName: string | null
  claudeSessionId: string | null
  /** Declared model tier for this step (populated by Phase 4B slice 1). */
  declaredTier?: 'fast' | 'balanced' | 'flagship' | null
  /** Resolved native model id for this step (populated by Phase 4B slice 1). */
  resolvedModel?: string | null
}

/** One awaiting-human park — awaitHuman's honest history rows (never spans). */
export interface PrimitivePark {
  taskId: string | null
  stepName: string | null
  parkedAt: string
  leaseOwner: string | null
}

/** Full facet payload of GET /api/primitives/:name. */
export interface PrimitiveDetail {
  primitive: PrimitiveSummary
  workers: PrimitiveWorkerProfile[]
  observedTools: PrimitiveObservedTool[]
  caveats: string[]
  runs: PrimitiveRun[]
  parks: PrimitivePark[]
  /** The recent-N window the runs cover — aggregates are "last N runs", never all-time. */
  window: number
}

/**
 * Maps one observed step (phase + step name) to the primitive that produced
 * it — the UI mirror of the daemon's primitiveForSpan. Phase ↔ primitive is
 * 1:1 for setup/code/merge; the shared 'verify' phase splits on the pinned
 * 'behaviour-verify' step name. Unknown/absent phases map to null — a Studio
 * node with no mapping simply renders no primitive link.
 */
export const primitiveForStep = (
  phase: string | null,
  stepName: string,
): string | null => {
  switch (phase) {
    case 'setup':
      return 'setupWorktree'
    case 'code':
      return 'runAgent'
    case 'verify':
      return stepName === 'behaviour-verify' ? 'behaviourVerify' : 'verify'
    case 'merge':
      return 'merge'
    default:
      return null
  }
}
