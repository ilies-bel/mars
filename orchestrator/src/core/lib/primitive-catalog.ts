/**
 * Primitive catalog — the code-pinned identity of the six pipeline
 * primitives: setupWorktree, runAgent, verify, behaviourVerify, merge, and
 * awaitHuman.
 *
 * This module is a pure, read-only projection source for the daemon's
 * `GET /view/primitives` routes (app-services `viewPrimitives` /
 * `viewPrimitive`). It never executes a primitive — it only names what each
 * one is, which trace phase its Step spans carry, WHO executes it (an agent
 * Worker, deterministic shell-outs via runTool, or a human), and — for agent
 * primitives — which Workers it can resolve to together with each Worker's
 * Authorization profile (model, effort, permission mode, forfeited tools).
 *
 * Deliberately self-contained: it imports the Worker registry
 * (`../workers`) but NOT `workflows/primitives/index.ts` — the catalog is
 * metadata, and pulling the full primitive implementations into the read
 * layer would drag workflow-engine dependencies into every AppServices
 * consumer. The one cross-module literal (`'behaviour-verify'`, pinned to
 * BEHAVIOUR_VERIFY_STEP_NAME) is asserted equal in the view-primitives test
 * so drift is caught at test time.
 */

import { WORKER_CONFIGS, type WorkerName } from '../workers'
import type { WorkerDeclaration } from '../workers/persisted-registry'
import type { TraceEventPhase } from './trace-events-store'

/** The closed set of primitive names, in pipeline order. */
export const PRIMITIVE_NAMES = [
  'setupWorktree',
  'runAgent',
  'verify',
  'behaviourVerify',
  'merge',
  'awaitHuman',
] as const

export type PrimitiveName = (typeof PRIMITIVE_NAMES)[number]

export const isPrimitiveName = (value: string): value is PrimitiveName =>
  (PRIMITIVE_NAMES as readonly string[]).includes(value)

/**
 * One Worker's Authorization profile (glossary term) projected for an agent
 * primitive — model, effort, permission mode, and forfeited tools. `source`
 * distinguishes code-pinned WORKER_CONFIGS entries from operator-declared
 * Workers in .mars/worker-registry.json.
 */
export interface PrimitiveWorkerProfile {
  workerName: string
  model: string
  effort: string
  permissionMode: string
  forfeitedTools: string[]
  source: 'built-in' | 'registry'
}

/**
 * WHO executes the primitive:
 *  - 'agent'  — dispatches a Worker through its provider adapter; its tool surface is the
 *               Worker's Authorization profile (declared, code-pinned).
 *  - 'shell'  — deterministic shell-outs via runTool; its tool surface is
 *               empirical (observed `tool_invoked` trace events).
 *  - 'human'  — no tool surface at all; it writes task state and raises an
 *               action-queue row (parks, not spans).
 */
export type PrimitiveExecutor = 'agent' | 'shell' | 'human'

export interface PrimitiveCatalogEntry {
  readonly name: PrimitiveName
  /** One-line description, mirroring the primitive's doc comment. */
  readonly description: string
  /**
   * The trace phase this primitive's Step spans (and runTool shell-outs)
   * carry. Null for awaitHuman — it parks before any span opens and so never
   * appears in step_started/step_ended.
   */
  readonly phase: TraceEventPhase | null
  readonly executor: PrimitiveExecutor
  /** Built-in Workers this primitive can resolve to (agent primitives only). */
  readonly workerNames: readonly WorkerName[]
  /** Honest caveats rendered verbatim in the UI — never conflated with the tool surface. */
  readonly caveats: readonly string[]
}

/**
 * The step name behaviourVerify runs under — pinned to
 * BEHAVIOUR_VERIFY_STEP_NAME in `workflows/primitives/behaviour-verify.ts`
 * (asserted equal in view-primitives.test.ts). behaviourVerify shares the
 * 'verify' phase with the static verify primitive; this step name is the
 * discriminator that keeps their run histories apart.
 */
export const BEHAVIOUR_VERIFY_SPAN_STEP_NAME = 'behaviour-verify'

export const PRIMITIVE_CATALOG: Readonly<Record<PrimitiveName, PrimitiveCatalogEntry>> = {
  setupWorktree: {
    name: 'setupWorktree',
    description:
      'Provision (or attach to) the task worktree off the integration branch, record the integration HEAD, and install its deps.',
    phase: 'setup',
    executor: 'shell',
    workerNames: [],
    caveats: [],
  },
  runAgent: {
    name: 'runAgent',
    description:
      'Run the coder through the selected headless provider inside the worktree — kind-aware Worker routing: Coder by default, Fixer on kind:fix, plus tag-routed operator-declared Workers.',
    phase: 'code',
    executor: 'agent',
    workerNames: ['Coder', 'Fixer'],
    caveats: [
      "mode:'manual' spawns no agent — the task parks awaiting-human and a Foreground session does the work in the leased worktree.",
    ],
  },
  verify: {
    name: 'verify',
    description:
      "Full-workspace static gate over the worktree's committed changes — every configured typecheck, test, and lint scope runs to protect cross-package contracts.",
    phase: 'verify',
    executor: 'shell',
    workerNames: [],
    caveats: [
      "mode:'manual' parks the task awaiting-human so a Foreground session performs the verification (e.g. visual QA).",
    ],
  },
  behaviourVerify: {
    name: 'behaviourVerify',
    description:
      "Behaviour verification gate — boots the task's preview dev server and dispatches the BehaviourVerifier Worker (Playwright MCP, read-only) against the task's Definition of Done.",
    phase: 'verify',
    executor: 'agent',
    workerNames: ['BehaviourVerifier'],
    caveats: [
      "When a live dev server is wired via the workflow environment, the Worker exercises the running surface and reports verdicts — otherwise the step emits a CAN'T-VERIFY draft proposal and merge proceeds.",
    ],
  },
  merge: {
    name: 'merge',
    description:
      'Fast-forward the task branch into the integration branch, serialized under the merge lock; removes the worktree and marks the task done on success.',
    phase: 'merge',
    executor: 'shell',
    workerNames: [],
    caveats: [
      'The conflict path escalates to Vega (the vcs-supervisor agent — a conditional agent surface with its own Authorization profile).',
      'Preview-gated tasks start a dev server and park awaiting-validation before the merge continuation runs.',
    ],
  },
  awaitHuman: {
    name: 'awaitHuman',
    description:
      "Park the task awaiting-human until the operator finishes the step (`mars step done`) — it writes task state and raises an action-queue row; nothing executes.",
    phase: null,
    executor: 'human',
    workerNames: [],
    caveats: [
      "Deprecated as an authoring surface — prefer mode:'manual' on runAgent or verify; both route through the same park machinery.",
    ],
  },
} as const

/**
 * Maps one observed Step span to the primitive that produced it.
 *
 * Phase ↔ primitive is 1:1 for setup/code/merge. The 'verify' phase is shared
 * by the static verify gate and behaviourVerify; the pinned
 * {@link BEHAVIOUR_VERIFY_SPAN_STEP_NAME} step name is the discriminator.
 * Spans with no phase (or an unknown one) map to null — never guessed.
 */
export const primitiveForSpan = (
  phase: string | null,
  stepName: string,
): PrimitiveName | null => {
  switch (phase) {
    case 'setup':
      return 'setupWorktree'
    case 'code':
      return 'runAgent'
    case 'verify':
      return stepName === BEHAVIOUR_VERIFY_SPAN_STEP_NAME ? 'behaviourVerify' : 'verify'
    case 'merge':
      return 'merge'
    default:
      return null
  }
}

/**
 * Projects the Authorization profiles of the Workers a primitive can resolve
 * to. Shell and human primitives have NO agent tool surface — empty array,
 * never a fabricated one.
 *
 * For runAgent, operator-declared Workers from `.mars/worker-registry.json`
 * are candidates too (tag routing); a registry declaration with the same name
 * as a built-in overrides it, mirroring `listMergedWorkers` semantics.
 * behaviourVerify is pinned to the BehaviourVerifier — registry declarations
 * never route there.
 */
export const buildWorkerProfiles = (
  name: PrimitiveName,
  registryDeclarations: readonly WorkerDeclaration[],
): PrimitiveWorkerProfile[] => {
  const entry = PRIMITIVE_CATALOG[name]
  if (entry.executor !== 'agent') return []

  const profiles = new Map<string, PrimitiveWorkerProfile>()
  for (const workerName of entry.workerNames) {
    const config = WORKER_CONFIGS[workerName]
    profiles.set(config.name, {
      workerName: config.name,
      model: config.model,
      effort: config.effort,
      permissionMode: config.permissionMode,
      forfeitedTools: [...config.disallowedTools],
      source: 'built-in',
    })
  }
  if (name === 'runAgent') {
    for (const decl of registryDeclarations) {
      profiles.set(decl.name, {
        workerName: decl.name,
        model: decl.model,
        effort: decl.effort,
        permissionMode: decl.permissionMode,
        forfeitedTools: [...decl.disallowedTools],
        source: 'registry',
      })
    }
  }
  return [...profiles.values()]
}
