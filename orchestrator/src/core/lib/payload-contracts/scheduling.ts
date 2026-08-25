/**
 * Payload contracts for the `scheduling-workflow-drift` family.
 *
 * Kinds: scheduling-decision, requeue-warning, workflow-install-drift,
 * workflow-draft-pending, fragmented-repo-layout, coder-question.
 */

import type { BudgetPressure } from '../budget-pressure.js'

// ── scheduling-decision ───────────────────────────────────────────────────────

/**
 * Raised by `lib/deferral-store.ts` when a task is deferred
 * (decision = 'deferred') and by `daemon/deferral-wake-sweeper.ts` when the
 * deferral is lifted (decision = 'woken'). The two raisers agree on every
 * field — they differ only on `decision` and `canRunNow`.
 */
export interface SchedulingDecisionPayload {
  taskId: string
  decision: 'deferred' | 'woken'
  reason: string
  pressure: BudgetPressure
  targetWindowEnd: string | null
  canRunNow: boolean
}

// ── requeue-warning ───────────────────────────────────────────────────────────

/**
 * Raised by `daemon/requeue-ceiling.ts` when a task is approaching (but has
 * not yet tripped) the re-queue ceiling. The `diagnostics` object supplies the
 * numbers the recipe displays to the operator.
 */
export interface RequeueWarningPayload {
  taskId: string
  diagnostics: {
    class: string
    maxAttempt: number
    elapsedMs: number
    boundMs: number
  }
}

// ── workflow-install-drift ────────────────────────────────────────────────────

/**
 * Raised by `daemon/reconcilers.ts` (workflowInstallDriftSweep) when one or
 * more bundled Workflow files are absent from the target repo's `.mars/workflows/`
 * directory.
 */
export interface WorkflowInstallDriftPayload {
  missingKinds: string[]
  fixCommand: string
}

// ── workflow-draft-pending ────────────────────────────────────────────────────

/**
 * Raised by `src/cli/commands/workflow.ts` when an agent submits a self-
 * authored workflow draft for operator approval.
 *
 * Note: the recipe reads `runbook` and `rawJs` from the payload, but the
 * actual raiser embeds both in the row's `body` field and only emits
 * `workflowName`, `path`, and `author` in the payload. Those fields therefore
 * read as `''` in humanDetail — an existing drift documented here rather than
 * silently swallowed by `UnauditedPayload`.
 */
export interface WorkflowDraftPendingPayload {
  workflowName: string
  /** Absolute path to the draft workflow file on disk. */
  path: string
  /** Identity of the agent that authored this draft. */
  author: string
  /**
   * Rendered runbook text. Not emitted by the known raiser — the runbook is
   * embedded in the row `body` instead. Reads as `''` in humanDetail.
   */
  runbook?: string
  /**
   * Raw JS source of the draft. Not emitted by the known raiser — the JS is
   * embedded in the row `body` instead. Reads as `''` in humanDetail.
   */
  rawJs?: string
}

// ── fragmented-repo-layout ────────────────────────────────────────────────────

/**
 * No raiser for `fragmented-repo-layout` has been found in the codebase at
 * typing time. This interface is derived solely from the keys its recipe reads.
 */
export interface FragmentedRepoLayoutPayload {
  workspace: string
  virtualStoreDir: unknown
}

// ── coder-question ────────────────────────────────────────────────────────────

/**
 * Raised by a running agent (typically via `mars action-queue raise`) when it
 * hits a decision it cannot resolve autonomously. The question text goes in the
 * row's `body` field (rendered as `ctx.body` in the recipe), not in the payload.
 */
export interface CoderQuestionPayload {
  taskId: string
}

// ── Kind map + representative payloads ───────────────────────────────────────

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface SchedulingContracts {
  'scheduling-decision': SchedulingDecisionPayload
  'requeue-warning': RequeueWarningPayload
  'workflow-install-drift': WorkflowInstallDriftPayload
  'workflow-draft-pending': WorkflowDraftPendingPayload
  'fragmented-repo-layout': FragmentedRepoLayoutPayload
  'coder-question': CoderQuestionPayload
}

/** Representative fixtures for the contract test. */
export const REPRESENTATIVE_PAYLOADS: Record<
  keyof SchedulingContracts,
  Record<string, unknown>
> = {
  'scheduling-decision': {
    taskId: 'mars-1',
    decision: 'deferred',
    reason: 'usage pressure is critical',
    pressure: 'critical',
    targetWindowEnd: '2026-08-25T12:00:00.000Z',
    canRunNow: false,
  },
  'requeue-warning': {
    taskId: 'mars-1',
    diagnostics: {
      class: 'retry-churn',
      maxAttempt: 8,
      elapsedMs: 5_760_000,
      boundMs: 7_200_000,
    },
  },
  'workflow-install-drift': {
    missingKinds: ['implement'],
    fixCommand: 'mars update --yes',
  },
  'workflow-draft-pending': {
    workflowName: 'my-workflow',
    path: '/repo/.mars/workflows/my-workflow-workflow.js',
    author: 'agent:planner',
    runbook: 'Step 1: do the thing.',
    rawJs: 'export default {}',
  },
  'fragmented-repo-layout': {
    workspace: 'packages/foo',
    virtualStoreDir: '/Users/user/project/.pnpm-store',
  },
  'coder-question': {
    taskId: 'mars-1',
  },
}
