/**
 * Action-queue recipe registry.
 *
 * One source of truth for human-language copy and action verbs for every
 * action-queue kind. Used by:
 *   - the CLI (action-queue list/show)
 *   - the action-queue view rows (buildActionQueueView)
 *   - alert chat-segment payloads
 *
 * Every kind in ACTION_QUEUE_KINDS must have a registered recipe — the
 * exhaustiveness test enforces this.
 */

import type { ActionQueueKind } from './action-queue'
import { classifyMarsVerb } from './chat-mars-verbs'

// ── Types ────────────────────────────────────────────────────────────────────

/** Structured fields for the expandable detail section of an alert card. */
export type RecipeHumanDetail = {
  raisedAt?: string
  entityId?: string
  /** Raw failure signature from the task. */
  failureSignature?: string
  /** Git branch the task was on. */
  branch?: string
  /** Worktree path. */
  worktree?: string
  /** Short excerpt from the raw error output. */
  errorExcerpt?: string
  /** Changelog text (for update-style kinds). */
  changelog?: string
  /** Additional kind-specific structured fields. */
  [key: string]: unknown
}

/** A single action button shown on an alert card. */
export type RecipeVerb = {
  /** Machine-readable op name — maps to a daemon POST /actions/<op>/:id call. */
  op: string
  /** Human-readable button label. */
  label: string
  /** Visual style. */
  style: 'primary' | 'danger' | 'default'
}

/** A labelled daemon operation that Mars can preload as a Notice response chip. */
export type PreloadedResponse = {
  id: string
  label: string
  target:
    | { type: 'verb'; op: string; entityId: string }
    | { type: 'subthread'; title: string }
}

/** Context object passed to recipe functions. */
export type RecipeContext = {
  kind: ActionQueueKind
  entityId: string
  payload: Record<string, unknown>
  context: Record<string, unknown>
  title: string
  body: string
  raisedAt: string
}

/** A complete recipe for one action-queue kind. */
export type Recipe = {
  /** One plain sentence a non-expert understands. */
  humanSummary: (ctx: RecipeContext) => string
  /** Structured detail fields for the expandable section. */
  humanDetail: (ctx: RecipeContext) => RecipeHumanDetail
  /**
   * Ordered action verbs specific to this kind.
   * Dismiss and Snooze are appended automatically by getRecipeVerbs.
   */
  verbs: RecipeVerb[] | ((ctx: RecipeContext) => RecipeVerb[])
  /**
   * Responses Mars can offer when this recipe is rendered as a Notice.
   * Notice responses deliberately omit AlertCard-only presentation styling.
   */
  preloadedResponses: PreloadedResponse[] | ((ctx: RecipeContext) => PreloadedResponse[])
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const str = (v: unknown): string =>
  typeof v === 'string' ? v : ''

const DISMISS: RecipeVerb = { op: 'dismiss', label: 'Dismiss', style: 'default' }
const SNOOZE: RecipeVerb = { op: 'snooze', label: 'Snooze', style: 'default' }

/**
 * Return the full verb list for a recipe: kind-specific verbs then Dismiss,
 * then Snooze. Every kind always gets both tail verbs.
 */
export const getRecipeVerbs = (
  recipe: Recipe,
  ctx: RecipeContext,
): RecipeVerb[] => {
  const base =
    typeof recipe.verbs === 'function' ? recipe.verbs(ctx) : recipe.verbs
  return [...base, DISMISS, SNOOZE]
}

/** Return the daemon operations available as preloaded Notice response chips. */
export const getRecipePreloadedResponses = (
  recipe: Recipe,
  ctx: RecipeContext,
): PreloadedResponse[] =>
  typeof recipe.preloadedResponses === 'function'
    ? recipe.preloadedResponses(ctx)
    : recipe.preloadedResponses

// ── Recipe registry ───────────────────────────────────────────────────────────

const RECIPE_DEFINITIONS = {
  // ── Task failures ──────────────────────────────────────────────────────────

  failed: {
    humanSummary: (ctx) => {
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      return `A task got stuck and Mars used up its retry — decide what to do with it (${taskId}).`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      failureSignature: str(ctx.payload['failureSignature']),
      errorExcerpt: str(ctx.payload['errorExcerpt']),
      branch: str(ctx.payload['branch']),
      worktree: str(ctx.payload['worktree']),
    }),
    verbs: [
      { op: 'restart', label: 'Restart', style: 'primary' },
      { op: 'purge', label: 'Discard task', style: 'danger' },
    ],
  },

  'steward-repeat': {
    humanSummary: (ctx) =>
      `Steward already tried to repair ${str(ctx.payload['targetKind'])} ${str(ctx.payload['targetId'])} at this version — review it before trying again.`,
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      targetKind: str(ctx.payload['targetKind']),
      targetId: str(ctx.payload['targetId']),
      targetVersion: str(ctx.payload['targetVersion']),
    }),
    verbs: [{ op: 'investigate', label: 'Investigate', style: 'primary' }],
  },

  'cancelled-blocker-cascade': {
    humanSummary: () =>
      'A blocker task was cancelled and Mars cancelled its dependents too — review which tasks were affected.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      originTaskId: str(ctx.payload['originTaskId']),
      cancelledTaskIds: ctx.payload['cancelledTaskIds'],
    }),
    verbs: [{ op: 'restart', label: 'Restart chain', style: 'primary' }],
  },

  'diagnose-inconclusive': {
    humanSummary: () =>
      'Mars tried to diagnose a failure but could not find a clear root cause — manual investigation is needed.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      failureSignature: str(ctx.payload['failureSignature']),
      errorExcerpt: str(ctx.payload['errorExcerpt']),
    }),
    verbs: [{ op: 'investigate', label: 'Investigate', style: 'primary' }],
  },

  // ── Worker questions ──────────────────────────────────────────────────────

  'coder-question': {
    humanSummary: (ctx) => {
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      return `A running task (${taskId}) hit a decision it cannot resolve alone — answer the question so it can continue.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      taskId: str(ctx.payload['taskId']),
      question: ctx.body,
    }),
    verbs: [],
  },

  'daemon-killed': {
    humanSummary: () =>
      'The background engine was stopped while tasks were running — those tasks need to be restarted.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      affectedTaskIds: ctx.payload['affectedTaskIds'],
      killedAt: str(ctx.payload['killedAt']),
    }),
    verbs: [
      {
        op: 'restart-all-daemon-killed',
        label: 'Restart all affected',
        style: 'primary',
      },
    ],
  },

  'daemon-died': {
    humanSummary: () =>
      'The background engine crashed unexpectedly — restart it to resume normal operation.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      exitCode: ctx.payload['exitCode'],
      crashedAt: str(ctx.payload['crashedAt']),
      lastError: str(ctx.payload['lastError']),
    }),
    verbs: [{ op: 'restart-daemon', label: 'Restart engine', style: 'primary' }],
  },

  // ── Worktree issues ────────────────────────────────────────────────────────

  'stale-worktree': {
    humanSummary: (ctx) => {
      const taskId = ctx.entityId
      return `A task's working copy has uncommitted changes that are just sitting there — clean it up or resume it (${taskId}).`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      worktree: str(ctx.payload['worktree']),
      branch: str(ctx.payload['branch']),
      uncommittedFiles: ctx.payload['uncommittedFiles'],
    }),
    verbs: [
      { op: 'prune-worktree', label: 'Clean up worktree', style: 'danger' },
    ],
  },

  'worktree-ahead': {
    humanSummary: (ctx) =>
      `A task's working copy has commits that were never merged — merge or discard them (${ctx.entityId}).`,
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      branch: str(ctx.payload['branch']),
      worktreePath: str(ctx.payload['worktreePath']),
      integrationBranch: str(ctx.payload['integrationBranch']),
      commitsAhead: ctx.payload['commitsAhead'],
      onMainLean: str(ctx.payload['onMainLean']),
      leaseOwned: ctx.payload['leaseOwned'],
    }),
    verbs: [
      { op: 'land-work', label: 'Land work', style: 'primary' },
      { op: 'prune-worktree', label: 'Discard unmerged work', style: 'danger' },
    ],
  },

  'prerequisite-failed': {
    humanSummary: () =>
      'A prerequisite check failed before a task could start — fix the underlying issue first.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      prerequisite: str(ctx.payload['prerequisite']),
      errorExcerpt: str(ctx.payload['errorExcerpt']),
    }),
    verbs: [{ op: 'restart', label: 'Retry', style: 'primary' }],
  },

  'done-with-unmerged-commits': {
    humanSummary: (ctx) =>
      `A task was marked done but its code was never merged into main — investigate and re-merge (${ctx.entityId}).`,
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      branch: str(ctx.payload['branch']),
      commitsAhead: ctx.payload['commitsAhead'],
      failureReasonCode: str(ctx.payload['failureReasonCode']),
    }),
    verbs: [
      { op: 'restart', label: 'Re-attempt merge', style: 'primary' },
    ],
  },

  // ── Proposals and planning ─────────────────────────────────────────────────

  'draft-proposal': {
    humanSummary: (ctx) => {
      const title = str(ctx.payload['title']) || ctx.title
      return `A new proposal is waiting for your review: "${title}".`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      proposalId: str(ctx.payload['proposalId']),
      title: str(ctx.payload['title']),
      source: str(ctx.payload['source']),
    }),
    verbs: [
      { op: 'grill', label: 'Shape into PRD', style: 'primary' },
      { op: 'promote', label: 'Promote & enqueue', style: 'default' },
    ],
  },

  'slices-dropped': {
    humanSummary: () =>
      'Some tasks were removed from the plan because they were out of scope or redundant — check what was dropped.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      droppedSlices: ctx.payload['droppedSlices'],
      reason: str(ctx.payload['reason']),
    }),
    verbs: [],
  },

  'hitl-slice-needs-operator': {
    humanSummary: () =>
      'A task in the plan requires a human to take over — attach to it and do the work manually.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      sliceId: str(ctx.payload['sliceId']),
      instructions: str(ctx.payload['instructions']),
    }),
    verbs: [],
  },

  'plan-approval': {
    humanSummary: () =>
      "A plan has been sliced into tasks and is waiting for your go-ahead before work starts — review and approve or reslice.",
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      proposalId: str(ctx.payload['proposalId']),
      sliceCount: ctx.payload['sliceCount'],
    }),
    verbs: [
      { op: 'approve-plan', label: 'Approve & enqueue', style: 'primary' },
      { op: 'reslice', label: 'Reslice with feedback', style: 'default' },
    ],
  },

  // ── Human-in-the-loop ──────────────────────────────────────────────────────

  'awaiting-validation': {
    humanSummary: () =>
      'A task finished and its preview is ready for you to check — validate it to merge, or reject to restart.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      devServerUrl: str(ctx.payload['devServerUrl']),
      branch: str(ctx.payload['branch']),
    }),
    verbs: [
      { op: 'validate', label: 'Validate & merge', style: 'primary' },
      { op: 'reject', label: 'Reject', style: 'danger' },
    ],
  },

  'awaiting-validation-preview-gone': {
    humanSummary: () =>
      'A task still needs a validation decision, but its preview is no longer reachable.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      devServerUrl: str(ctx.payload['devServerUrl']) || str(ctx.payload['remoteUrl']),
      previewUnavailableAt: str(ctx.payload['previewUnavailableAt']),
      branch: str(ctx.payload['branch']),
    }),
    verbs: [
      { op: 'validate', label: 'Validate & merge', style: 'primary' },
      { op: 'reject', label: 'Reject', style: 'danger' },
    ],
  },

  'awaiting-human': {
    humanSummary: (ctx) => {
      const owner = str(ctx.payload['leaseOwner']) || 'someone'
      return `${owner} is working interactively on a task — it will resume automatically when the lease is released.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      leaseOwner: str(ctx.payload['leaseOwner']),
      leasedAt: str(ctx.payload['leasedAt']),
      note: str(ctx.payload['note']),
      branch: str(ctx.payload['branch']),
    }),
    verbs: [],
  },

  // ── Verification ──────────────────────────────────────────────────────────

  'behaviour-unverified': {
    humanSummary: () =>
      'A task was merged but Mars could not check it actually works — follow the linked proposal to verify manually.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      proposalId: str(ctx.payload['proposalId']),
      reason: str(ctx.payload['reason']),
      branch: str(ctx.payload['branch']),
    }),
    verbs: [],
  },

  'arc-verification-failed': {
    humanSummary: () =>
      "Post-merge verification found that an arc's goals were not satisfied — investigate and fix the output or mark it resolved.",
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      originId: str(ctx.payload['originId']),
      failedCriteria: ctx.payload['failedCriteria'],
      verifyOutput: str(ctx.payload['verifyOutput']),
    }),
    verbs: [{ op: 'investigate', label: 'Investigate', style: 'primary' }],
  },

  // ── Daemon and infrastructure ──────────────────────────────────────────────

  'daemon-code-drift': {
    humanSummary: () =>
      'The background engine is running old code — restart it to pick up your latest changes.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      runningCommit: str(ctx.payload['runningCommit']),
      headCommit: str(ctx.payload['headCommit']),
      behindBy: ctx.payload['behindBy'],
    }),
    verbs: [{ op: 'restart-daemon', label: 'Restart engine', style: 'primary' }],
  },

  'workflow-install-drift': {
    humanSummary: (ctx) => {
      const missing = Array.isArray(ctx.payload['missingKinds'])
        ? ctx.payload['missingKinds'].filter((kind): kind is string => typeof kind === 'string')
        : []
      return missing.length === 1
        ? `The "${missing[0]}" Workflow is not installed, so tasks routed to it cannot dispatch.`
        : 'Some built-in Workflows are not installed, so tasks routed to them cannot dispatch.'
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      missingKinds: ctx.payload['missingKinds'],
      fixCommand: str(ctx.payload['fixCommand']),
    }),
    verbs: [],
  },

  'subscriber-stalled': {
    humanSummary: () =>
      'An internal event processor keeps failing on the same event and has stopped — fix the underlying error to unblock it.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      subscriberName: str(ctx.payload['subscriberName']),
      errorExcerpt: str(ctx.payload['errorExcerpt']),
      failCount: ctx.payload['failCount'],
    }),
    verbs: [],
  },

  'observability-store-oversize': {
    humanSummary: () =>
      'The observability database has grown past 500 MB — prune it to free disk space.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      sizeMb: ctx.payload['sizeMb'],
      thresholdMb: ctx.payload['thresholdMb'],
    }),
    verbs: [{ op: 'prune-observability', label: 'Prune store', style: 'default' }],
  },

  'orphaned-origin': {
    humanSummary: () =>
      "A blocked task's origin task was deleted — the dependent is stuck and needs to be resolved manually.",
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      missingOriginId: str(ctx.payload['missingOriginId']),
    }),
    verbs: [
      { op: 'purge', label: 'Discard task', style: 'danger' },
    ],
  },

  'phantom-task': {
    humanSummary: () =>
      'A task stalled with no active worker — Mars stopped it automatically. Restart or drop it.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      recordedPid: ctx.payload['recordedPid'],
      detectedAt: str(ctx.payload['detectedAt']),
    }),
    verbs: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  },

  'outbox-lag': {
    humanSummary: () =>
      'An event queue is backed up — a subscriber may be wedged. Check the subscriber status.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      lag: ctx.payload['lag'],
      threshold: ctx.payload['threshold'],
      oldestCursor: str(ctx.payload['oldestCursor']),
    }),
    verbs: [],
  },

  // ── Reflection and evolution ───────────────────────────────────────────────

  'reflect-recommended': {
    humanSummary: () =>
      'Mars spotted patterns worth reflecting on — run a reflection to surface improvement proposals.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      signals: ctx.payload['signals'],
      windowStart: str(ctx.payload['windowStart']),
    }),
    verbs: [{ op: 'run-reflect', label: 'Run reflection', style: 'primary' }],
  },

  // ── API and rate limits ────────────────────────────────────────────────────

  'api-outage': {
    humanSummary: () =>
      'The Claude API is down — tasks are paused automatically and will resume once the API recovers.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      openedAt: str(ctx.payload['openedAt']),
      occurrences: ctx.payload['occurrences'],
    }),
    verbs: [],
  },

  'provider-rate-limited': {
    humanSummary: (ctx) => {
      const resetsAt = str(ctx.payload['resetsAtIso'])
      return resetsAt
        ? `The Claude API rate limit was hit — dispatch will resume automatically at ${resetsAt}.`
        : 'The Claude API rate limit was hit — dispatch will resume automatically once the limit resets.'
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      resetsAt: str(ctx.payload['resetsAtIso']),
      occurrences: ctx.payload['occurrences'],
    }),
    verbs: [],
  },

  // ── Verify gates ──────────────────────────────────────────────────────────

  'gate-broken': {
    humanSummary: (ctx) => {
      const verdict = str(ctx.payload['verdict'])
      return `A verify gate keeps failing the same way${verdict ? ` ("${verdict}")` : ''} — the gate itself may be broken, not the tasks.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      verdict: str(ctx.payload['verdict']),
      affectedCount: ctx.payload['affectedCount'],
    }),
    verbs: [],
  },

  'signature-storm': {
    humanSummary: (ctx) => {
      const signature = str(ctx.payload['signature'])
      const count = ctx.payload['count'] ?? ctx.payload['streak']
      return signature
        ? `${count} tasks failed with signature ${signature}.`
        : 'The same failure hit multiple tasks in a row — the environment may be broken. Queue is PAUSED.'
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      signature: str(ctx.payload['signature']),
      streak: ctx.payload['streak'],
    }),
    verbs: [{ op: 'show-all', label: 'Show all', style: 'default' }],
  },

  'gate-enrichment': {
    humanSummary: () =>
      "A new failure pattern was spotted — review the proposed gate check and approve it or retire the pattern.",
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      signature: str(ctx.payload['signature']),
      candidateCheck: str(ctx.payload['candidateCheck']),
      seenCount: ctx.payload['seenCount'],
    }),
    verbs: [
      { op: 'enrich-approve', label: 'Approve gate check', style: 'primary' },
      { op: 'enrich-retire', label: 'Retire pattern', style: 'default' },
    ],
  },

  'gate-enrichment-stale': {
    humanSummary: (ctx) => {
      const sig = str(ctx.payload['signature'])
      const count = ctx.payload['passCount']
      return sig
        ? `Enforcing check enrich:${sig} passed ${count} verify runs in a row — consider retiring it if the regression is resolved.`
        : `An enforcing enrichment check has run clean for many consecutive verify runs — it may be stale.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      signature: str(ctx.payload['signature']),
      passCount: ctx.payload['passCount'],
    }),
    verbs: [
      { op: 'enrich-retire', label: 'Retire check', style: 'default' },
    ],
  },

  // ── Budget ────────────────────────────────────────────────────────────────

  'budget-window': {
    humanSummary: () =>
      "Spending in the current time window has crossed the warning threshold — no tasks are paused, but keep an eye on it.",
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      spentTokens: ctx.payload['spentTokens'],
      thresholdTokens: ctx.payload['thresholdTokens'],
      windowStart: str(ctx.payload['windowStart']),
    }),
    verbs: [],
  },

  'budget-arc': {
    humanSummary: (ctx) => {
      const arcId = str(ctx.payload['arcId']) || ctx.entityId
      return `An arc's spending crossed the per-arc ceiling — work is still running, but review it (arc ${arcId}).`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      arcId: str(ctx.payload['arcId']),
      spentTokens: ctx.payload['spentTokens'],
      ceilingTokens: ctx.payload['ceilingTokens'],
    }),
    verbs: [],
  },

  // ── Quality and workflows ─────────────────────────────────────────────────

  'scorer-suggested': {
    humanSummary: (ctx) => {
      const workflow = str(ctx.payload['workflowName']) || ctx.entityId
      return `Mars suggested a quality scorer for the "${workflow}" workflow — accept it to start tracking quality automatically.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      workflowName: str(ctx.payload['workflowName']),
      scorerId: str(ctx.payload['scorerId']),
      rationale: str(ctx.payload['rationale']),
    }),
    verbs: [
      { op: 'scorer-accept', label: 'Accept scorer', style: 'primary' },
      { op: 'scorer-dismiss', label: 'Dismiss suggestion', style: 'default' },
    ],
  },

  'promotion-decision': {
    humanSummary: (ctx) => {
      const verdict = str(ctx.payload['verdict'])
      const workflow = str(ctx.payload['workflowName']) || ctx.entityId
      if (verdict === 'promote') {
        return `The "${workflow}" workflow is performing better than before — promote it to make it the default.`
      } else if (verdict === 'retire') {
        return `The "${workflow}" workflow is performing worse than before — consider retiring it.`
      }
      return `A promotion decision is ready for the "${workflow}" workflow — review the benchmark and act.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      workflowName: str(ctx.payload['workflowName']),
      verdict: str(ctx.payload['verdict']),
      ledgerId: str(ctx.payload['ledgerId']),
      benchmarkSummary: ctx.payload['benchmarkSummary'],
    }),
    verbs: [
      { op: 'promote-workflow', label: 'Promote', style: 'primary' },
      { op: 'retire-workflow', label: 'Retire', style: 'danger' },
    ],
  },

  'workflow-draft-pending': {
    humanSummary: (ctx) => {
      const name = str(ctx.payload['workflowName']) || ctx.entityId
      return `A self-authored workflow "${name}" is waiting for your approval before it can be dispatched.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      workflowName: str(ctx.payload['workflowName']),
      runbook: str(ctx.payload['runbook']),
      rawJs: str(ctx.payload['rawJs']),
    }),
    verbs: [
      { op: 'workflow-approve', label: 'Approve workflow', style: 'primary' },
    ],
  },

  'tool-promotion': {
    humanSummary: (ctx) => {
      const helperKey = str(ctx.payload['helperKey']) || ctx.entityId
      return `A helper tool "${helperKey}" has benchmark evidence ready — review and promote or reject it.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      helperKey: str(ctx.payload['helperKey']),
      attemptId: str(ctx.payload['attemptId']),
      benchmarkBefore: ctx.payload['benchmarkBefore'],
      benchmarkAfter: ctx.payload['benchmarkAfter'],
    }),
    verbs: [
      { op: 'approve-tool', label: 'Promote helper', style: 'primary' },
      { op: 'reject-tool', label: 'Reject helper', style: 'danger' },
    ],
  },

  'env-incident': {
    humanSummary: (ctx) => {
      const sig = str(ctx.payload['signature'])
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      return sig
        ? `Environmental failure on task ${taskId} (${sig}) — queue NOT paused; restart once environment is healthy.`
        : `Environmental failure on task ${taskId} — infrastructure condition, not a code regression.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      failureSignature: str(ctx.payload['signature']),
      taskId: str(ctx.payload['taskId']),
      envRestartCount: ctx.payload['envRestartCount'],
    }),
    verbs: [
      { op: 'restart', label: 'Restart task', style: 'primary' },
    ],
  },

  // ── Dispatch / queue ────────────────────────────────────────────────────────

  'stale-queued': {
    humanSummary: (ctx) => {
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      const ageMs = ctx.payload['queuedAgeMs']
      const ageMin = typeof ageMs === 'number' ? Math.round(ageMs / 60_000) : '?'
      return `Task ${taskId} has been waiting in the queue for ${ageMin} min — the worker pool may be saturated or the dispatcher may be stuck.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      taskId: str(ctx.payload['taskId']),
      queuedAgeMs: ctx.payload['queuedAgeMs'],
      activeWorkerCount: ctx.payload['activeWorkerCount'],
      queueDepth: ctx.payload['queueDepth'],
      dispatchDecisionSummary: ctx.payload['dispatchDecisionSummary'],
    }),
    verbs: [
      { op: 'restart', label: 'Restart task', style: 'primary' },
    ],
  },

  'stale-queued-summary': {
    humanSummary: (ctx) => {
      const suppressedCount = ctx.payload['suppressedCount']
      return typeof suppressedCount === 'number'
        ? `${suppressedCount} stale queued task alert(s) were suppressed to keep the action queue usable.`
        : 'Stale queued task alerts were suppressed to keep the action queue usable.'
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      suppressedCount: ctx.payload['suppressedCount'],
      activeWorkerCount: ctx.payload['activeWorkerCount'],
      implementCap: ctx.payload['implementCap'],
      queueDepth: ctx.payload['queueDepth'],
      dispatchDecisionSummary: ctx.payload['dispatchDecisionSummary'],
    }),
    verbs: [],
  },

  'spend-control-notice': {
    humanSummary: (ctx) => {
      const direction = str(ctx.payload['direction'])
      return direction === 'paused'
        ? 'The spend controller has paused dispatch — token spend crossed the configured threshold.'
        : 'The spend controller has resumed dispatch — spend dropped below the resume threshold.'
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      reason: str(ctx.payload['reason']),
      direction: str(ctx.payload['direction']),
      rampBackFactor: ctx.payload['rampBackFactor'],
    }),
    verbs: [],
  },
  'scheduling-decision': {
    humanSummary: (ctx) => {
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      return ctx.payload['decision'] === 'woken'
        ? `Usage pressure cleared, so Mars can run ${taskId} now.`
        : `Mars deferred ${taskId} until provider usage pressure clears.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      taskId: str(ctx.payload['taskId']),
      decision: str(ctx.payload['decision']),
      reason: str(ctx.payload['reason']),
      pressure: str(ctx.payload['pressure']),
      targetWindowEnd: ctx.payload['targetWindowEnd'],
      canRunNow: ctx.payload['canRunNow'],
    }),
    verbs: [],
  },
  'requeue-warning': {
    humanSummary: (ctx) => {
      const diag = ctx.payload['diagnostics'] as Record<string, unknown> | undefined
      const kind = str(diag?.['class'])
      return `Task is approaching the requeue ceiling (predicted class: ${kind}).`
    },
    humanDetail: (ctx) => {
      const diag = ctx.payload['diagnostics'] as Record<string, unknown> | undefined
      return {
        raisedAt: ctx.raisedAt,
        predictedClass: str(diag?.['class']),
        maxAttempt: diag?.['maxAttempt'],
        elapsedMs: diag?.['elapsedMs'],
        boundMs: diag?.['boundMs'],
      }
    },
    verbs: [],
  },
} satisfies Record<ActionQueueKind, Omit<Recipe, 'preloadedResponses'>>

/**
 * The Alert verbs are the existing source of truth for each recipe's available
 * daemon operations. A Notice presents the same operations as compact chips,
 * without AlertCard's destructive/primary styling or Dismiss/Snooze tail verbs.
 */
const REGISTRY: Record<ActionQueueKind, Recipe> = Object.fromEntries(
  Object.entries(RECIPE_DEFINITIONS).map(([kind, recipe]) => [
    kind,
    {
      ...recipe,
      preloadedResponses: (ctx) =>
        recipe.verbs
          .filter(({ op }) => classifyMarsVerb(op) === 'safe')
          .map(({ op, label }) => ({
            id: op,
            label,
            target: { type: 'verb' as const, op, entityId: ctx.entityId },
          })),
    },
  ]),
) as Record<ActionQueueKind, Recipe>

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up the recipe for a given kind.
 * Throws if the kind is not registered (should never happen when the
 * exhaustiveness test is green).
 */
export const lookupRecipe = (kind: ActionQueueKind): Recipe => {
  const recipe = REGISTRY[kind]
  if (!recipe) {
    throw new Error(`No recipe registered for action-queue kind "${kind}"`)
  }
  return recipe
}

/**
 * Return all registered kinds in definition order.
 * Used by the exhaustiveness test to verify complete coverage.
 */
export const registeredKinds = (): ActionQueueKind[] =>
  Object.keys(REGISTRY) as ActionQueueKind[]

/**
 * Render the plain-language copy for an operational event without involving an
 * LLM. Notices carry only a kind and payload, so this adapter supplies the
 * recipe context fields that are conventionally embedded in that payload.
 */
export const humanSummary = (
  kind: ActionQueueKind,
  payload: Record<string, unknown>,
): string => {
  const entityId =
    str(payload['entityId']) ||
    str(payload['taskId']) ||
    str(payload['proposalId']) ||
    kind
  const context = payload['context']
  return lookupRecipe(kind).humanSummary({
    kind,
    entityId,
    payload,
    context:
      typeof context === 'object' && context !== null && !Array.isArray(context)
        ? context as Record<string, unknown>
        : {},
    title: str(payload['title']),
    body: str(payload['body']),
    raisedAt: str(payload['raisedAt']),
  })
}

/**
 * Human-friendly Mars opening message used when the action queue is empty.
 * Rendered as the seeded first message in the chat feed (slice 2 of the
 * collapse-hero PRD) and available to any CLI/UI surface that needs a
 * "nothing pending" status line.
 */
export const noPendingHumanSummary =
  "Nothing's pressing right now — what would you like to work on?"
