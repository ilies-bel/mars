/**
 * Verify-heuristic registry — the open set of tool-specific knowledge the
 * verify runner consults instead of hard-coding (TARGET §4.5).
 *
 * `core/lib/git/verify.ts` used to carry the TypeScript toolchain in its own
 * body: the decoy marker, an `npx tsc` predicate, a tsconfig/`node_modules`
 * presence probe and a package-manager-aware dep-refresh retry. Every repo
 * that is not a TypeScript repo paid for that, and no repo could add its own
 * equivalent without editing the runner. Those two blocks are now registered
 * heuristics — shipped wired (§5: zero configuration reproduces today's
 * behaviour), swappable by registration.
 *
 * DISPATCH IS `serial` (TARGET §3.6): heuristics are consulted in registration
 * order, and the first one to return a non-`undefined` value wins. Registration
 * order is therefore the priority list, which is why the two built-ins below
 * are seeded in a fixed order — `typescript-toolchain` before
 * `infra-failure-patterns`, matching the order the two guards ran in the
 * original runner body.
 *
 * A heuristic decides; it never records. It has no access to `ctx`, to the
 * task row, or to `ctx.services.store` — the ADR-0052 funnel is untouched by
 * anything in this file.
 *
 * Built on `@mars/workflow`'s keyed service registry, same rationale as
 * `core/workers/provider-registry.ts` / `worker-registry.ts` /
 * `workflows/primitives/registry.ts`.
 */

import { createServiceRegistry, type Disposer } from '@mars/workflow'

import { typescriptToolchainHeuristic } from '../tools/verify/heuristics/typescript-toolchain'
import { infraFailurePatternsHeuristic } from '../tools/verify/heuristics/infra-failure-patterns'
import type {
  HeuristicExec,
  PreStepDecision,
  RetryPlan,
  VerifyHeuristic,
  VerifyStepOutcome,
  VerifyStepRef,
  VerifyVerdict,
} from '../tools/verify/heuristics/types'

export type {
  HeuristicExec,
  PreStepDecision,
  RetryPlan,
  VerifyHeuristic,
  VerifyStepOutcome,
  VerifyStepRef,
  VerifyVerdict,
}

type HeuristicMap = Record<string, VerifyHeuristic>

const registry = createServiceRegistry<HeuristicMap>()

/**
 * Register a heuristic under its `name`. Returns a disposer that withdraws it
 * — every registration is reversible (TARGET §3.5), which is what makes it
 * safe to register a repo-specific heuristic for one run.
 */
export const registerVerifyHeuristic = (heuristic: VerifyHeuristic): Disposer =>
  registry.provide(heuristic.name, heuristic)

/** Every registered heuristic, in registration (= priority) order. */
export const listVerifyHeuristics = (): readonly VerifyHeuristic[] => {
  const out: VerifyHeuristic[] = []
  for (const key of registry.keys()) {
    const heuristic = registry.get(key)
    if (heuristic !== undefined) out.push(heuristic)
  }
  return out
}

/**
 * Serial dispatch of `beforeStep`: the first heuristic with an opinion decides
 * the step is not to be run. `undefined` means run it normally.
 */
export const decideBeforeVerifyStep = (
  step: VerifyStepRef,
  cwd: string,
): PreStepDecision | undefined => {
  for (const heuristic of listVerifyHeuristics()) {
    const decision = heuristic.beforeStep?.(step, cwd)
    if (decision !== undefined) return decision
  }
  return undefined
}

/**
 * Serial dispatch of `classify` over a FAILING step. `step` is omitted at
 * suite-level call sites (the `review` shell, which has recorded outputs but
 * not the specs) — heuristics that need the spec return `undefined` there.
 */
export const classifyVerifyFailure = (
  result: VerifyStepOutcome,
  step?: VerifyStepRef,
): VerifyVerdict | undefined => {
  for (const heuristic of listVerifyHeuristics()) {
    const verdict = heuristic.classify?.(result, step)
    if (verdict !== undefined) return verdict
  }
  return undefined
}

/** Serial dispatch of `retry`: the first heuristic that wants one gets it. */
export const planVerifyRetry = (
  result: VerifyStepOutcome,
  step: VerifyStepRef,
): RetryPlan | undefined => {
  for (const heuristic of listVerifyHeuristics()) {
    const plan = heuristic.retry?.(result, step)
    if (plan !== undefined) return plan
  }
  return undefined
}

/**
 * Convenience predicate for the suite-level infra retry in the `review` shell,
 * which asks only "is this failing output the environment?". Equivalent to
 * `classifyVerifyFailure({ passed: false, output })?.kind === 'infra'`.
 */
export const isInfraFailure = (output: string): boolean =>
  classifyVerifyFailure({ passed: false, output })?.kind === 'infra'

// ---- built-in seeds (order is priority; see the module note) ----------------
registerVerifyHeuristic(typescriptToolchainHeuristic)
registerVerifyHeuristic(infraFailurePatternsHeuristic)
