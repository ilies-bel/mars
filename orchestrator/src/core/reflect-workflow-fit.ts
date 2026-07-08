/**
 * Workflow-fit reflection: evaluate whether a session's workflow steps fit the
 * work and how tokens were spent, returning draft proposal specs for detected
 * outliers.
 *
 * Pure module — `evaluateWorkflowFit` has no side effects. The caller is
 * responsible for persistence (or skipping it for --dry-run).
 */

import type { SessionStepRun } from './lib/deep-reflect-query'

/**
 * A spec for a draft proposal to be created by the caller.
 */
export interface WorkflowFitSpec {
  title: string
  solution: string
  notes: string
  kpiTag: string
}

/** Minimal task token record needed for evaluation. */
interface EvalTaskRecord {
  taskId: string
  totals: {
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
  }
}

/**
 * Minimal input shape for `evaluateWorkflowFit`. Structurally compatible with
 * `SessionArcsResult` from `lib/deep-reflect-query` so the CLI command can
 * pass session data directly. Tests supply synthetic values for the fields
 * that evaluation actually reads.
 */
export interface WorkflowFitInput {
  sessionId: string
  arcs: Array<{ tasks: EvalTaskRecord[] }>
  stepRuns: SessionStepRun[]
}

/**
 * Duration threshold: manual steps whose wall-clock time exceeds this value
 * are flagged even when their status is 'done', because an operator-blocking
 * step that runs for >4 h is a pipeline-sizing smell regardless of outcome.
 */
const MANUAL_TIMEOUT_MS = 4 * 60 * 60 * 1000 // 4 hours

/**
 * Token outlier multiplier: a task whose weighted-token spend exceeds
 * (session mean × this value) is flagged as a candidate for progressive
 * discovery.
 */
const TOKEN_OUTLIER_MULTIPLIER = 3

/**
 * Absolute token threshold used when only a single task is in the session
 * (no peers to compare against for a mean).
 */
const SINGLE_TASK_TOKEN_THRESHOLD = 50_000

/**
 * Step names matching this pattern are treated as manual / human-gated steps.
 * Covers common naming conventions used in workflow definitions:
 * - `manual-*`, `human-*`
 * - `user-*`, `await-*`
 * - `validate`, `review`
 */
const MANUAL_STEP_RE = /manual|human|user[-_]|await[-_]|validate|review/i

/**
 * Evaluate a loaded session result and return proposal specs for workflow-fit
 * outliers. Two categories are detected:
 *
 * 1. **Manual-step timeout** — a step whose name signals operator involvement
 *    has failed, or ran longer than {@link MANUAL_TIMEOUT_MS}. Proposal:
 *    replace it with a runbook-guided sub-workflow.
 *
 * 2. **Token outlier** — a task with weighted-token spend more than
 *    {@link TOKEN_OUTLIER_MULTIPLIER}× the session mean (or above the
 *    {@link SINGLE_TASK_TOKEN_THRESHOLD} for single-task sessions). Proposal:
 *    apply the progressive-discovery skill.
 *
 * Returns an empty array when no outliers are found.
 */
export function evaluateWorkflowFit(input: WorkflowFitInput): WorkflowFitSpec[] {
  const specs: WorkflowFitSpec[] = []

  // ── Detection 1: manual step that timed out or failed ─────────────────────
  const problematicManualSteps = input.stepRuns.filter((sr) => {
    if (!MANUAL_STEP_RE.test(sr.stepName)) return false
    const timedOut = sr.durationMs !== null && sr.durationMs > MANUAL_TIMEOUT_MS
    return sr.status !== 'done' || timedOut
  })

  if (problematicManualSteps.length > 0) {
    const uniqueNames = [...new Set(problematicManualSteps.map((s) => s.stepName))]
    const nameList = uniqueNames.join(', ')
    specs.push({
      title: 'Replace timed-out manual step with runbook split',
      solution: `Split the manual step(s) [${nameList}] into a runbook-guided sub-workflow so the operator can resume incrementally instead of blocking the pipeline indefinitely.`,
      notes: `Detected ${problematicManualSteps.length} manual step run(s) that timed out or failed in session ${input.sessionId}. Affected steps: ${nameList}.`,
      kpiTag: 'workflow_manual_step_timeout',
    })
  }

  // ── Detection 2: excessive token spend on a single task ───────────────────
  const taskTokens = input.arcs.flatMap((arc) =>
    arc.tasks.map((t) => ({
      taskId: t.taskId,
      weightedTokens:
        t.totals.inputTokens +
        t.totals.outputTokens +
        t.totals.cacheCreateTokens +
        t.totals.cacheReadTokens * 0.1,
    })),
  )

  if (taskTokens.length > 0) {
    const outliers =
      taskTokens.length > 1
        ? taskTokens.filter((t) => {
            // Compare each task to the mean of all OTHER tasks (exclude-self mean)
            // so the outlier does not inflate the baseline it is compared against.
            const others = taskTokens.filter((o) => o !== t)
            const otherMean =
              others.reduce((s, o) => s + o.weightedTokens, 0) / others.length
            return t.weightedTokens > otherMean * TOKEN_OUTLIER_MULTIPLIER
          })
        : taskTokens.filter((t) => t.weightedTokens > SINGLE_TASK_TOKEN_THRESHOLD)

    if (outliers.length > 0) {
      const ids = outliers.map((t) => t.taskId).join(', ')
      const tokenSummary = outliers
        .map((t) => `${t.taskId}=${Math.round(t.weightedTokens)}`)
        .join(', ')
      const sessionMean =
        taskTokens.length > 1
          ? Math.round(
              taskTokens.reduce((s, t) => s + t.weightedTokens, 0) /
                taskTokens.length,
            )
          : null
      const meanNote =
        sessionMean !== null ? `; session mean: ${sessionMean}` : ''
      specs.push({
        title: 'Apply progressive-discovery skill to token-heavy step',
        solution: `Task(s) [${ids}] consumed disproportionate token spend (${tokenSummary} weighted tokens${meanNote}). Apply the progressive-discovery skill to scope the work incrementally before committing to a full implementation pass.`,
        notes: `Detected in session ${input.sessionId}.`,
        kpiTag: 'workflow_token_outlier_step',
      })
    }
  }

  return specs
}
