/**
 * Growth types — pure data for the step-suggestion heuristics (no HTTP, DB,
 * or UI imports). A heuristic reads task history and proposes a NEW
 * WORKFLOW STEP the operator could add (e.g. "tasks touching ui/
 * repeatedly fail verify on screenshots -> add a browser-check step"), it
 * never proposes editing an existing step or a config/prompt tweak — that is
 * `reflector.ts`'s job.
 */

import type { ReflectCorpusEntry } from '../core/lib/reflect-query.js'

export interface StepSuggestion {
  /** Short imperative title (<= 60 chars), e.g. "Add browser-check step to task workflow". */
  title: string
  /** Stable snake_case slug for the pattern, used for proposal dedup (e.g. 'ui_verify_screenshot_gap'). */
  rootCauseKey: string
  /** Task ids where this pattern was observed. */
  affectedTaskIds: string[]
  /** 1-2 sentences citing the evidence (task ids, counts, error text). */
  rationale: string
  /** The new step being proposed, in workflow-authoring terms (e.g. 'browser-check'). */
  proposedStep: string
  /** Self-contained Mars task/proposal prompt a fresh agent or operator can act on. */
  prompt: string
}

/**
 * A registrable heuristic: pure function from task history to zero or more
 * {@link StepSuggestion}s. No side effects — persistence is the caller's job
 * (`persistStepSuggestions`), so heuristics stay trivially unit-testable.
 */
export interface StepSuggestionHeuristic {
  /** Stable id for this heuristic (used in logs/tests, not persisted). */
  id: string
  /** One-line description of the pattern this heuristic looks for. */
  describe: string
  evaluate(entries: readonly ReflectCorpusEntry[]): StepSuggestion[]
}
