/**
 * Default step-suggestion heuristics — the opinionated starter set. Each
 * heuristic is a pure function over a {@link ReflectCorpusEntry} window; no
 * DB/network access, so they're plain unit-testable functions.
 */

import type { ReflectCorpusEntry } from '../core/lib/reflect-query.js'
import type { StepSuggestion, StepSuggestionHeuristic } from './types.js'

const MIN_FREQUENCY = 2

/** True when the entry's prompt or error text mentions a `ui/`-rooted path. */
const touchesUiPath = (entry: ReflectCorpusEntry): boolean =>
  /(^|[\s"'`(])ui\//i.test(entry.promptPrefix) || /(^|[\s"'`(])ui\//i.test(entry.errorTail ?? '')

const SCREENSHOT_PATTERN = /screenshot|visual regression|pixel diff|playwright.*(snapshot|screenshot)/i

/**
 * Tasks touching ui/ that repeatedly fail verify with screenshot/visual
 * signals -> suggest adding a browser-check step to the task workflow so
 * the failure is caught before it reaches the operator as a stumble.
 */
export const uiScreenshotVerifyGapHeuristic: StepSuggestionHeuristic = {
  id: 'ui-screenshot-verify-gap',
  describe:
    'tasks touching ui/ repeatedly fail verify on screenshot/visual checks -> suggest a browser-check step',
  evaluate: (entries) => {
    const matches = entries.filter(
      (e) =>
        e.status === 'failed' &&
        e.failedPhase === 'verify' &&
        touchesUiPath(e) &&
        SCREENSHOT_PATTERN.test(e.errorTail ?? ''),
    )
    if (matches.length < MIN_FREQUENCY) return []

    const affectedTaskIds = matches.map((e) => e.taskId)
    const suggestion: StepSuggestion = {
      title: 'Add a browser-check step to the task workflow',
      rootCauseKey: 'ui_verify_screenshot_gap',
      affectedTaskIds,
      rationale: `${matches.length} task(s) touching ui/ failed verify on a screenshot/visual signal (${affectedTaskIds.slice(0, 5).join(', ')}${affectedTaskIds.length > 5 ? ', …' : ''}). The current task workflow has no dedicated browser-driving step, so this class of failure only surfaces after verify runs the whole suite.`,
      proposedStep: 'browser-check',
      prompt: `Add a 'browser-check' step to the task workflow ahead of the final verify gate, gated on files touching ui/**. It should launch the app, take a screenshot, and fail fast with a clear diff before the full verify suite runs. Evidence: ${matches.length} task(s) failing verify on screenshot/visual signals — ${affectedTaskIds.join(', ')}. Expected effect: catches UI regressions earlier, reducing wasted verify-phase token spend on tasks that are going to fail anyway. Verify: run the task workflow render and confirm the new step appears before verify; confirm a task with a deliberately broken ui/ screenshot now stops at browser-check instead of full verify. Save your work.`,
    }
    return [suggestion]
  },
}

const KNOWN_GUARDED_REASON_CODES = new Set(['none', 'unknown', null])

/**
 * The same failureReasonCode recurring 3+ times at the verify phase, with
 * no existing gate named after it, suggests the workflow is missing a step
 * dedicated to catching that failure class early.
 */
export const repeatedVerifyFailureReasonHeuristic: StepSuggestionHeuristic = {
  id: 'repeated-verify-failure-reason',
  describe:
    'the same verify-phase failureReasonCode recurs 3+ times -> suggest a dedicated step for that failure class',
  evaluate: (entries) => {
    const byReason = new Map<string, ReflectCorpusEntry[]>()
    for (const e of entries) {
      if (e.status !== 'failed' || e.failedPhase !== 'verify') continue
      const reason = e.failureReasonCode
      if (!reason || KNOWN_GUARDED_REASON_CODES.has(reason)) continue
      const list = byReason.get(reason) ?? []
      list.push(e)
      byReason.set(reason, list)
    }

    const suggestions: StepSuggestion[] = []
    for (const [reason, group] of byReason) {
      if (group.length < 3) continue
      const affectedTaskIds = group.map((e) => e.taskId)
      const rootCauseKey = `repeated_verify_failure_${reason.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
      suggestions.push({
        title: `Add a dedicated step for '${reason}' verify failures`,
        rootCauseKey,
        affectedTaskIds,
        rationale: `${group.length} task(s) failed verify with failureReasonCode='${reason}' (${affectedTaskIds.slice(0, 5).join(', ')}${affectedTaskIds.length > 5 ? ', …' : ''}). No workflow step currently targets this failure class ahead of the general verify gate.`,
        proposedStep: `guard-${reason.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        prompt: `Add a workflow step (or verify sub-gate) that specifically checks for the '${reason}' failure class before the coder hands off to full verify. Evidence: ${group.length} recurrences — ${affectedTaskIds.join(', ')}. Expected effect: raises completeness by catching this failure earlier in the pipeline, and saves weighted tokens by avoiding a full verify run on work that's already known to fail this check. Verify: run \`mars workflow render <task-workflow>\` and confirm the new step is present; enqueue a task that reproduces the '${reason}' failure and confirm it stops at the new step. Save your work.`,
      })
    }
    return suggestions
  },
}

/** The opinionated default heuristic set installed at module init. */
export const DEFAULT_STEP_SUGGESTION_HEURISTICS: readonly StepSuggestionHeuristic[] = [
  uiScreenshotVerifyGapHeuristic,
  repeatedVerifyFailureReasonHeuristic,
]
