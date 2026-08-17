/**
 * The verify-heuristic contract (docs/rework/TARGET-ARCHITECTURE.md §4.5).
 *
 * A *heuristic* is tool-specific knowledge the verify runner must not carry:
 * "an `npx tsc` step with no local tsc binary is a skip, not a failure",
 * "output matching these patterns is an environment flake, not a regression".
 * Before this seam existed those strings were hard-coded in the runner
 * (`core/lib/git/verify.ts`), which meant a Kotlin repo paid for TypeScript
 * knowledge and no repo could add its own.
 *
 * Three hooks, all optional, all pure decisions — a heuristic never records a
 * step, never touches task state, and never spawns the step itself. It returns
 * a decision and the runner (or the `review` primitive shell) applies it. This
 * is what keeps the ADR-0052 funnel intact: heuristics are the most pluggable
 * thing in the verify path and they still cannot write anything.
 *
 * Dispatch is `serial` (TARGET §3.6): heuristics are consulted in registration
 * order and the first non-`undefined` return wins, so registration order is
 * the priority list. Returning `undefined` means "no opinion, ask the next
 * one".
 *
 * This module is a LEAF — it imports nothing — so a heuristic implementation
 * and the registry that holds them can both depend on it without a cycle.
 */

/**
 * The parts of a verify step a heuristic is allowed to look at. Structurally
 * a subset of `VerifyStepSpec` (`core/lib/git/verify.ts`), declared here so
 * heuristics do not import the runner.
 */
export interface VerifyStepRef {
  readonly name: string
  readonly cmd: string
  readonly args: readonly string[]
  readonly required?: boolean
}

/** What a step run produced, as far as a heuristic needs to know. */
export interface VerifyStepOutcome {
  readonly passed: boolean
  readonly output: string
  readonly stderr?: string
  readonly exitCode?: number | null
}

/**
 * `beforeStep` decision: do not run this step, record this instead.
 *
 * `passed: true` is a skip (the step is not applicable here — no toolchain).
 * `passed: false` is a pre-flight failure (the step is applicable but the
 * environment is broken); the runner treats it like any other failure, so a
 * required step stops the suite.
 */
export interface PreStepDecision {
  readonly passed: boolean
  readonly output: string
  /**
   * Optional stderr. Set it when the message must survive the structured
   * `firstFailedOutput` assembly in the `review` shell, which reads stderr and
   * stdout rather than the combined `output` field for steps that have a cmd.
   */
  readonly stderr?: string
}

/**
 * `classify` decision on a FAILING step.
 *
 * - `skip`  — the failure is not a code failure; record the step as PASSED
 *             with `output`. The runner applies this.
 * - `infra` — the failure is environmental, not a regression. ADVISORY: the
 *             runner records the step unchanged; the `review` primitive shell
 *             reads it to decide whether to re-run the whole suite once.
 *             Keeping it advisory is what makes this a pure refactor — it is
 *             exactly the split of responsibilities the code already had.
 */
export type VerifyVerdict =
  | { readonly kind: 'skip'; readonly output: string }
  | { readonly kind: 'infra' }

/** Run a best-effort repair command. Rejections are the caller's to swallow. */
export type HeuristicExec = (
  cmd: string,
  args: readonly string[],
  cwd: string,
) => Promise<void>

/**
 * `retry` decision on a FAILING step: re-run it once, optionally repairing the
 * environment first. One retry only — a heuristic cannot ask for a budget.
 */
export interface RetryPlan {
  /** Named so narration can say which heuristic asked for the retry. */
  readonly name: string
  /** Best-effort environment repair, run before the retry. Never throws. */
  prepare?(exec: HeuristicExec, cwd: string): Promise<void>
  /**
   * Rewrite the retry's own recorded output (e.g. to prepend a sentinel the
   * failure classifier keys off). Return `undefined` to record it verbatim.
   * Only consulted when the retry ALSO failed.
   */
  afterRetry?(retry: VerifyStepOutcome): { output: string; stderr: string } | undefined
}

export interface VerifyHeuristic {
  /** Registration key and the name narration reports. */
  readonly name: string
  /** Decide the step before it runs. */
  beforeStep?(step: VerifyStepRef, cwd: string): PreStepDecision | undefined
  /** Reclassify a failing step. `step` is absent at suite-level call sites. */
  classify?(result: VerifyStepOutcome, step?: VerifyStepRef): VerifyVerdict | undefined
  /** Ask for a single retry of a failing step. */
  retry?(result: VerifyStepOutcome, step: VerifyStepRef): RetryPlan | undefined
}
