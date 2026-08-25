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
 *
 * ## Typing the still-`unaudited` kinds
 *
 * PRD `2d84a65a-shrink-the-unaudited-list-in-action-queu` is typing the
 * still-`unaudited` kinds in `action-queue-payloads.ts` incrementally, one
 * family at a time. Each family's consumer slice touches this file too —
 * once its kinds' payload contracts land, its recipe entries below trade
 * `ctx.payload['field']` bracket access for the typed contract's fields.
 *
 * `UNAUDITED_KIND_FAMILY` in `action-queue-payloads.ts` is the single source
 * of truth for which family owns which kind — not a kind list re-copied into
 * a consumer slice's own prompt. This file mirrors that assignment with a
 * `// family: <name>` comment directly above every still-unaudited kind's
 * entry in `RECIPE_DEFINITIONS`, so a consumer slice can locate every entry
 * it owns (they are not grouped together below — the sections predate the
 * family split) without re-deriving the mapping by hand.
 *
 * The mirror is not decoration: `__tests__/action-queue-recipe-family-markers.test.ts`
 * fails if a marker is missing, names the wrong family, or is left behind on a
 * kind that has since been typed. A slice that finishes its family therefore
 * deletes its markers here in the same change that removes its kinds from
 * `UNAUDITED_KIND_FAMILY`.
 */

import { classifyKind, DERIVED_KINDS, type ActionQueueClass, type ActionQueueKind } from './action-queue-kinds'

export type { ActionQueueClass } from './action-queue-kinds'
import {
  awaitingHumanSituation,
  type LeaseExpiredPayload,
  type LeaseParkPayload,
  type PayloadFor,
} from './action-queue-payloads'
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
  /**
   * Uncommitted paths sitting in the task's worktree right now, or `null` when
   * it was not probed. `null` means "unknown", never "clean" — the destructive
   * verbs on this card must not read a failed probe as nothing to lose.
   */
  worktreeDirtyCount?: number | null
  /** Additional kind-specific structured fields. */
  [key: string]: unknown
}

/** A single action button shown on an alert card. */
export type RecipeVerb = {
  /** Machine-readable op name — maps to a daemon POST /actions/<op>/:id call. */
  op: string
  /** Human-readable button label. */
  label: string
  /**
   * Visual style. Every value here MUST be accepted by the client's
   * `alertVerbSchema.style` enum (`ui/src/shared/schemas.ts`), because a verb
   * style the client does not recognise fails validation for the entire row,
   * not just the button.
   *
   * This type used to say `danger` where the client said `destructive`. One
   * consumer translated (`action-queue.ts`, the chat/alert path); the
   * action-queue view did not, so every row carrying a destructive verb —
   * every failed task, among others — was rejected by the client union and
   * silently replaced with a fallback that dropped `arcGoal`, `humanSummary`
   * and `humanDetail`. The queue rendered those rows with a bare title and no
   * cause at all. Keep one vocabulary; do not reintroduce a translation layer.
   */
  style: 'primary' | 'destructive' | 'default' | 'snooze'
  /**
   * Text the client copies to the clipboard for an `op: 'copy'` verb — the
   * runnable command behind a deliberate operator gesture. Ignored for every
   * other op. Matches `alertVerbSchema.hint` (`ui/src/shared/schemas.ts`),
   * which already accepted this field before any recipe emitted it.
   */
  hint?: string
}

/** A labelled daemon operation that Mars can preload as a Notice response chip. */
export type PreloadedResponse = {
  id: string
  label: string
  target:
    | { type: 'verb'; op: string; entityId: string }
    | { type: 'subject'; title: string }
}

/**
 * Context object passed to recipe functions.
 *
 * Generic over the kind so `payload` carries that kind's declared contract
 * from `action-queue-payloads.ts` — the same type its raiser is checked
 * against. For a kind marked `typed` in `ACTION_QUEUE_PAYLOAD_AUDIT`, reading
 * a key no raiser emits is a compile error rather than a blank detail panel.
 */
export type RecipeContext<K extends ActionQueueKind = ActionQueueKind> = {
  kind: K
  entityId: string
  payload: PayloadFor<K>
  context: Record<string, unknown>
  title: string
  body: string
  raisedAt: string
}

/** A complete recipe for one action-queue kind. */
export type Recipe<K extends ActionQueueKind = ActionQueueKind> = {
  /**
   * Structural class of this kind — mirrors `classifyKind(kind)` from
   * `action-queue-kinds.ts` but stored on the recipe so renderers and chat
   * adapters read it directly without a second import.
   *
   * - `condition` — derived on read from live state; operator must act.
   * - `decision`  — row-backed; operator must decide.
   * - `notice`    — row-backed; operator acknowledges; Mars is handling it.
   *
   * Populated automatically by the registry (see REGISTRY construction below);
   * individual recipe definitions in RECIPE_DEFINITIONS do not declare it.
   */
  kindClass: ActionQueueClass
  /** One plain sentence a non-expert understands. */
  humanSummary: (ctx: RecipeContext<K>) => string
  /** Structured detail fields for the expandable section. */
  humanDetail: (ctx: RecipeContext<K>) => RecipeHumanDetail
  /**
   * Ordered action verbs specific to this kind.
   * Dismiss and Snooze are appended automatically by getRecipeVerbs.
   */
  verbs: RecipeVerb[] | ((ctx: RecipeContext<K>) => RecipeVerb[])
  /**
   * Responses Mars can offer when this recipe is rendered as a Notice.
   * Notice responses deliberately omit AlertCard-only presentation styling.
   */
  preloadedResponses: PreloadedResponse[] | ((ctx: RecipeContext<K>) => PreloadedResponse[])
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const str = (v: unknown): string =>
  typeof v === 'string' ? v : ''

const DISMISS: RecipeVerb = { op: 'dismiss', label: 'Dismiss', style: 'default' }
const SNOOZE: RecipeVerb = { op: 'snooze', label: 'Snooze', style: 'snooze' }

/**
 * Kinds whose rows the generic `dismiss` op can actually act on. The daemon's
 * entity handler maps `dismiss` to proposal dismissal and nothing else, so
 * appending Dismiss to any other kind produces a button that 500s
 * ("proposal <id> not found"). Derived condition kinds clear through their own
 * operation (e.g. `dismiss-daemon-died` deletes the crash marker) or by the
 * condition ceasing to hold; stored operator-decision kinds resolve atomically
 * through their own verbs.
 */
const GENERIC_DISMISS_KINDS = new Set<string>(['draft-proposal'])

/**
 * Return the full verb list for a recipe: kind-specific verbs, then Dismiss
 * only where the generic dismiss op can function, then Snooze only for kinds
 * that have a stored row (i.e. not derived condition kinds).
 *
 * Derived condition kinds have no stored row, so the snooze UPDATE would match
 * zero rows and silently report success. Consistent with the Dismiss fix
 * (which already applies the same guard), Snooze is omitted for DERIVED_KINDS.
 */
export const getRecipeVerbs = (
  recipe: Recipe,
  ctx: RecipeContext,
): RecipeVerb[] => {
  const base =
    typeof recipe.verbs === 'function' ? recipe.verbs(ctx) : recipe.verbs
  const isDerived = DERIVED_KINDS.has(ctx.kind as ActionQueueKind)
  if (GENERIC_DISMISS_KINDS.has(ctx.kind)) {
    return isDerived ? [...base, DISMISS] : [...base, DISMISS, SNOOZE]
  }
  return isDerived ? [...base] : [...base, SNOOZE]
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
      const base = `A task got stuck and Mars used up its automatic retry — nothing is fixing this now, you need to decide what to do (${taskId}).`
      // The dirty-worktree count belongs in the SUMMARY, not just the detail:
      // it is the fact that decides between `continue` and the destructive
      // verbs, and the destructive verbs sit one click away in this same row.
      // A summary that omits it invites `Restart` on a worktree holding the
      // whole task (the 2026-08-20 mars-70dc2672 near-miss: 145 uncommitted
      // lines, and the alert mentioned none of them).
      const dirty = ctx.payload['worktreeDirtyCount']
      return typeof dirty === 'number' && dirty > 0
        ? `${base} Its working copy holds ${dirty} uncommitted path(s) — Restart and Discard would destroy them; use Continue to keep them.`
        : base
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      failureSignature: str(ctx.payload['failureSignature']),
      errorExcerpt: str(ctx.payload['errorExcerpt']),
      branch: str(ctx.payload['branch']),
      worktree: str(ctx.payload['worktree']),
      worktreeDirtyCount:
        typeof ctx.payload['worktreeDirtyCount'] === 'number'
          ? ctx.payload['worktreeDirtyCount']
          : null,
    }),
    verbs: [
      { op: 'restart', label: 'Restart', style: 'primary' },
      { op: 'purge', label: 'Discard task', style: 'destructive' },
    ],
  },

  'steward-repeat': {
    humanSummary: (ctx) =>
      `The automated repair system already tried to fix ${str(ctx.payload['targetKind'])} ${str(ctx.payload['targetId'])} at this version — Mars cannot retry automatically, you need to review it.`,
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
      dependentTaskId: str(ctx.payload['dependentTaskId']),
      cancelledBlockerTaskId: str(ctx.payload['cancelledBlockerTaskId']),
    }),
    verbs: [{ op: 'restart', label: 'Restart chain', style: 'primary' }],
  },

  'diagnose-inconclusive': {
    humanSummary: () =>
      'Mars tried to diagnose a failure but could not find a clear root cause — manual investigation is needed.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      parentTaskId: str(ctx.payload['parentTaskId']),
      choreId: str(ctx.payload['choreId']),
      verdictKind: str(ctx.payload['verdictKind']),
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

  // family: daemon-health
  'daemon-killed': {
    humanSummary: () =>
      'The background engine was stopped while tasks were running — those tasks need to be restarted.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      branch: str(ctx.payload['branch']),
      error: str(ctx.payload['error']),
    }),
    verbs: [
      {
        op: 'continue-all-daemon-killed',
        label: 'Restart all affected',
        style: 'primary',
      },
    ],
  },

  'daemon-died': {
    humanSummary: (ctx) => {
      const crashedAt = str(ctx.payload['crashDetectedAt'])
      return crashedAt
        ? `The background engine crashed (detected at ${crashedAt}) and restarted itself — Mars tried to fix this automatically, but you need to verify it is healthy and dismiss this alert.`
        : 'The background engine crashed and restarted itself — Mars tried to fix this automatically, but you need to verify it is healthy and dismiss this alert.'
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      pid: ctx.payload['pid'],
      startedAt: str(ctx.payload['startedAt']),
      crashDetectedAt: str(ctx.payload['crashDetectedAt']),
    }),
    verbs: [{ op: 'dismiss-daemon-died', label: 'Dismiss', style: 'primary' }],
  },

  // family: daemon-health
  'daemon-outage': {
    humanSummary: (ctx) => {
      const outageMs = typeof ctx.payload['outageMs'] === 'number' ? ctx.payload['outageMs'] : null
      const strandedCount =
        typeof ctx.payload['strandedTaskCount'] === 'number'
          ? ctx.payload['strandedTaskCount']
          : null
      const outageSummary = outageMs !== null
        ? `~${Math.round(outageMs / 60_000)} min`
        : 'an extended period'
      return strandedCount !== null
        ? `The background engine was offline for ${outageSummary} — ${strandedCount} task(s) were queued during the outage and will now be dispatched.`
        : `The background engine was offline for ${outageSummary} — tasks queued during the outage will now be dispatched.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      lastBeatAt: str(ctx.payload['lastBeatAt']),
      detectedAt: str(ctx.payload['detectedAt']),
      outageMs: ctx.payload['outageMs'],
      strandedTaskCount: ctx.payload['strandedTaskCount'],
    }),
    verbs: [],
  },

  // ── Worktree issues ────────────────────────────────────────────────────────

  'stale-worktree': {
    // This condition is age-based, not dirty-tree-based: it fires when a
    // task's worktree directory hasn't been touched (mtime) past
    // MARS_STALE_WORKTREE_HOURS, regardless of whether it holds uncommitted
    // changes. See deriveStaleWorktreeConditions in
    // core/daemon/view/derived-conditions.ts, the only place that raises
    // this kind, for the payload keys this recipe may rely on.
    humanSummary: (ctx) => {
      const taskId = ctx.entityId
      const ageHours = ctx.payload['ageHours']
      const status = str(ctx.payload['status'])
      const ageText = typeof ageHours === 'number' ? `${ageHours}h` : 'a while'
      const statusText = status ? ` (status: ${status})` : ''
      return `Mars is cleaning up a task workspace that has been inactive for ${ageText}${statusText} — no action needed from you (${taskId}).`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      status: str(ctx.payload['status']),
      prompt: str(ctx.payload['prompt']),
      branch: str(ctx.payload['branch']),
      ageHours: ctx.payload['ageHours'],
      updatedAt: str(ctx.payload['updatedAt']),
    }),
    verbs: [
      { op: 'prune-worktree', label: 'Clean up worktree', style: 'destructive' },
    ],
  },

  'worktree-ahead': {
    humanSummary: (ctx) =>
      `A task's working copy has commits that were never merged (${ctx.entityId}) — nothing is fixing this automatically, you need to merge or discard them.`,
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
      { op: 'prune-worktree', label: 'Discard unmerged work', style: 'destructive' },
    ],
  },

  'prerequisite-failed': {
    humanSummary: () =>
      'A prerequisite check failed before a task could start — fix the underlying issue first.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      dependentTaskId: str(ctx.payload['dependentTaskId']),
      failedBlockerTaskId: str(ctx.payload['failedBlockerTaskId']),
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
      integration: str(ctx.payload['integration']),
    }),
    verbs: [
      { op: 'restart', label: 'Re-attempt merge', style: 'primary' },
    ],
  },

  // ── Proposals and planning ─────────────────────────────────────────────────

  'draft-proposal': {
    humanSummary: (ctx) => {
      const title = str(ctx.payload['title']) || ctx.title
      return `You have a new proposal to review: "${title}" — shape it into a PRD or promote it directly.`
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

  // family: slice-workflow
  'slices-dropped': {
    humanSummary: () =>
      'Some tasks were removed from the plan because they were out of scope or redundant — check what was dropped.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      droppedCount: ctx.payload['droppedCount'],
      survivorCount: ctx.payload['survivorCount'],
    }),
    verbs: [],
  },

  // family: slice-workflow
  'slice-failed': {
    humanSummary: () =>
      'Mars could not turn this PRD into tasks — inspect the failure, then explicitly slice it again when ready.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      errorExcerpt: str(ctx.payload['error']),
    }),
    verbs: [],
  },

  // family: slice-workflow
  'hitl-slice-needs-operator': {
    humanSummary: () =>
      'You need to take over a task in this plan — pick it up and complete the work manually.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      sliceIndex: ctx.payload['sliceIndex'],
      subTaskId: ctx.payload['subTaskId'],
    }),
    verbs: [],
  },

  // ── Human-in-the-loop ──────────────────────────────────────────────────────

  'awaiting-validation': {
    humanSummary: () =>
      'You need to review this completed task — validate it to merge the work, or reject to start over.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      devServerUrl: str(ctx.payload['devServerUrl']),
      branch: str(ctx.payload['branch']),
    }),
    verbs: [
      { op: 'validate', label: 'Validate & merge', style: 'primary' },
      { op: 'reject', label: 'Reject', style: 'destructive' },
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
      { op: 'reject', label: 'Reject', style: 'destructive' },
    ],
  },

  /**
   * Three situations raise this kind, and they need three different sentences.
   * The recipe used to render the lease sentence unconditionally, so an
   * agent-raised escalation ("recovery found its arc already done") got a
   * summary that flatly contradicted its own title, over an empty detail panel
   * — it read `payload.note` and `payload.branch`, which no raiser has ever
   * emitted. Discriminate on the payload; never assume the lease case.
   */
  'awaiting-human': {
    humanSummary: (ctx) => {
      switch (awaitingHumanSituation(ctx.payload)) {
        case 'lease-park': {
          // `Partial<…>` rather than a plain narrow: rows raised before the
          // `situation` discriminator existed carry the lease keys without it,
          // and must still render this sentence. Key names stay checked.
          const p = ctx.payload as Partial<LeaseParkPayload>
          const owner = str(p.leaseOwner) || 'someone'
          const step = str(p.stepName)
          return `${owner} is working interactively on this task${step ? ` (step '${step}')` : ''} — signal done when the step is finished.`
        }
        case 'lease-expired': {
          const p = ctx.payload as Partial<LeaseExpiredPayload>
          const owner = str(p.leaseOwner) || 'someone'
          const age = typeof p.ageMinutes === 'number' ? ` ${p.ageMinutes} min` : ''
          return `${owner}'s session has been idle${age} — nobody is working on this task. Continue in the worktree or release it.`
        }
        case 'escalation': {
          // The escalating agent's own words are the only accurate summary
          // here: the payload is free-form and is often empty entirely.
          const sentence = ctx.body.trim().split(/(?<=[.!?])\s/)[0] ?? ''
          // A stub body ("parked", "Test body") is not a summary — fall back
          // rather than passing a fragment off as one.
          return sentence.length >= 20
            ? sentence
            : 'You need to decide — an agent stopped and escalated this task. Read the details and choose what to do.'
        }
      }
    },
    humanDetail: (ctx) => {
      const situation = awaitingHumanSituation(ctx.payload)
      const base = { raisedAt: ctx.raisedAt, entityId: ctx.entityId, situation }
      if (situation === 'escalation') {
        // Free-form and agent-authored: render every scalar it carries, plus
        // the body, so an escalation can never present a blank panel.
        const scalars = Object.entries(ctx.payload as Record<string, unknown>)
          .filter(([k, v]) =>
            k !== 'occurrences' && k !== 'situation' &&
            (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
        return { ...base, note: ctx.body, ...Object.fromEntries(scalars) }
      }
      const p = ctx.payload as Partial<LeaseParkPayload> & Partial<LeaseExpiredPayload>
      return {
        ...base,
        taskId: str(p.taskId) || ctx.entityId,
        leaseOwner: str(p.leaseOwner),
        leasedAt: str(p.leasedAt),
        leaseNote: str(p.leaseNote),
        ...(situation === 'lease-park'
          ? { stepName: str(p.stepName) }
          : { ageMinutes: p.ageMinutes ?? 0 }),
      }
    },
    verbs: [],
  },

  // ── Verification ──────────────────────────────────────────────────────────

  'behaviour-unverified': {
    humanSummary: () =>
      'A task was merged but Mars could not check it actually works — follow the linked proposal to verify manually.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      proposalId: str(ctx.payload.proposalId),
      reason: str(ctx.payload.reason),
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
      findings: ctx.payload['findings'],
      landedCommits: ctx.payload['landedCommits'],
    }),
    verbs: [{ op: 'investigate', label: 'Investigate', style: 'primary' }],
  },

  // ── Daemon and infrastructure ──────────────────────────────────────────────

  'daemon-code-drift': {
    humanSummary: (ctx) => {
      const running = str(ctx.payload['runningCommit']).slice(0, 7)
      const head = str(ctx.payload['headCommit']).slice(0, 7)
      const behindBy = ctx.payload['behindBy']
      const behindNote =
        typeof behindBy === 'number'
          ? ` (${behindBy} commit${behindBy === 1 ? '' : 's'} behind)`
          : ''
      const shaNote = running && head ? ` — ${running} → ${head}` : ''
      return `An update is available for the background engine${behindNote}${shaNote} — it will not apply automatically, you need to restart the engine to pick up your latest changes.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      runningCommit: str(ctx.payload['runningCommit']),
      headCommit: str(ctx.payload['headCommit']),
      behindBy: ctx.payload['behindBy'],
      dependencyDrift: ctx.payload['dependencyDrift'],
    }),
    verbs: (ctx) => {
      const dependencyDrift = ctx.payload['dependencyDrift'] === true
      return [
        {
          op: 'restart-daemon',
          label: dependencyDrift ? 'Restart engine (after install)' : 'Restart engine',
          style: 'primary',
        },
      ]
    },
  },

  'workflow-install-drift': {
    humanSummary: (ctx) => {
      const missing = Array.isArray(ctx.payload['missingKinds'])
        ? ctx.payload['missingKinds'].filter((kind): kind is string => typeof kind === 'string')
        : []
      return missing.length === 1
        ? `The "${missing[0]}" Workflow is not installed, so tasks routed to it cannot run.`
        : 'Some built-in Workflows are not installed, so tasks routed to them cannot run.'
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
      'Mars is restarting an internal processor that keeps failing on the same event — no action needed from you.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      subscriberId: str(ctx.payload['subscriberId']),
      errorExcerpt: str(ctx.payload['errorExcerpt']),
      failCount: ctx.payload['failCount'],
    }),
    verbs: [],
  },

  // family: daemon-health
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
      "A task is stuck because its parent task was deleted — nothing is fixing this automatically, you need to resolve it manually.",
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      missingOriginId: str(ctx.payload['missingOriginId']),
    }),
    verbs: [
      { op: 'purge', label: 'Discard task', style: 'destructive' },
    ],
  },

  'phantom-task': {
    humanSummary: () =>
      'Mars stopped a task that had no active worker and cleaned it up automatically — no action needed from you.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      recordedPid: ctx.payload['recordedPid'],
      detectedAt: str(ctx.payload['detectedAt']),
    }),
    verbs: [{ op: 'restart', label: 'Restart', style: 'primary' }],
  },

  // family: daemon-health
  'outbox-lag': {
    humanSummary: () =>
      'An internal processor is backed up and may be stuck — check its status.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      lag: ctx.payload['lag'],
      threshold: ctx.payload['threshold'],
      subscriber: str(ctx.payload['subscriber']),
    }),
    verbs: [],
  },

  // ── Reflection and evolution ───────────────────────────────────────────────

  'reflect-recommended': {
    humanSummary: () =>
      'Mars spotted patterns in recent work worth reviewing — this is informational, no action needed from you.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      evidence: ctx.payload['evidence'],
    }),
    verbs: [{ op: 'run-reflect', label: 'Run reflection', style: 'primary' }],
  },

  // ── API and rate limits ────────────────────────────────────────────────────

  // family: spend-provider
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

  // family: spend-provider
  'provider-rate-limited': {
    humanSummary: (ctx) => {
      const resetsAt = str(ctx.payload['resetsAtIso'])
      return resetsAt
        ? `The Claude API rate limit was hit — new tasks will resume automatically at ${resetsAt}.`
        : 'The Claude API rate limit was hit — new tasks will resume automatically once the limit resets.'
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
      return `A verify gate keeps failing the same way${verdict ? ` ("${verdict}")` : ''} — the gate itself may be broken, not the tasks — nothing is fixing this automatically, you need to look at it.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      verdict: str(ctx.payload['verdict']),
      // No derivation populates `affectedCount` (the `gate-broken` row's
      // payload only ever carries gate/verdict/originTaskId/streak) — reading
      // an unpopulated key here silently renders undefined forever. Dropped
      // rather than left dangling; see mars-89537cf3 for the daemon-code-drift
      // sibling of this same defect class.
    }),
    // Restoring a gate re-runs that gate's own command — a full build or test
    // suite that can take minutes. That does not belong inside a daemon HTTP
    // request, so this is a `copy` verb handing the operator the exact runnable
    // command, the same gesture `scorer-suggested` and `workflow-draft-pending`
    // use for their deliberate mutations. Primary style: it's the row's whole
    // reason to exist.
    //
    // The op MUST be one the daemon (or the client) actually handles. A bespoke
    // `restore-gate` op renders an identical-looking button that POSTs to
    // `/actions/restore-gate/:id` and 404s with `Unknown action op` — a dead
    // button is worse than no button, since the operator reads it as "I tried
    // to restore and it refused".
    verbs: (ctx) => {
      const gate = str(ctx.payload['gate'])
      return [
        {
          op: 'copy',
          label: 'Restore gate',
          style: 'primary',
          hint: `mars verify-gate restore ${gate || '<gate-id>'}`,
        },
      ]
    },
  },

  'verify-uncovered': {
    humanSummary: (ctx) => {
      const scope = str(ctx.payload['scope']) || ctx.entityId
      return `Decide whether to add an automated check for ${scope} — a task merged without any check covering these changes.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      scope: str(ctx.payload['scope']),
      changedPaths: ctx.payload['changedPaths'],
      recipe: str(ctx.payload['recipe']),
    }),
    verbs: [],
  },

  'signature-storm': {
    humanSummary: (ctx) => {
      const signature = str(ctx.payload['signature'])
      const count = ctx.payload['count'] ?? ctx.payload['streak']
      // Read from ctx to determine actual dispatch state rather than claiming
      // it is paused unconditionally. The view builder (OPERATIONAL_ALERT_COPY)
      // owns the authoritative pause clause via live pauseState; the recipe
      // only adds it when a raiser embeds the flag directly in the payload or
      // context (e.g. a future raiser that captures dispatch state at raise time).
      const isPaused =
        ctx.payload['dispatchPaused'] === true || ctx.context['dispatchPaused'] === true
      // The pause clause is conditional, never baked into the sentence: this
      // row outlives the breaker, and the view builder's own resumed branch
      // says "Dispatch has since resumed" — an unconditional "the work queue is
      // paused" would print directly above that contradiction. Note the view
      // builder overrides humanSummary ONLY on the Steward-escalation branch,
      // so this sentence is what the operator actually reads in both the paused
      // and the resumed state.
      const pausedClause = isPaused ? ' The work queue is paused while it monitors.' : ''
      // The signature stays out of the prose — the view builder's title already
      // renders it verbatim, and `humanDetail` carries it for anyone who needs
      // the raw fingerprint. It survives here only as the ternary discriminator.
      return signature
        ? `Mars detected ${count} tasks failing with the same error pattern — it is monitoring automatically, no action needed from you.${pausedClause}`
        : `Mars detected the same failure across multiple tasks — it is monitoring automatically, no action needed from you.${pausedClause}`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      signature: str(ctx.payload['signature']),
      streak: ctx.payload['streak'],
    }),
    verbs: [{ op: 'show-all', label: 'Show all', style: 'default' }],
  },

  /**
   * The row asks the operator to approve or retire a candidate check, so the
   * candidate check is the one thing it must show. It used to read
   * `payload.candidateCheck` and `payload.seenCount`, neither of which any
   * raiser emits — the decision was requested while the thing being decided
   * was withheld. The candidate lives in `stepSpec`, and it is an *object*:
   * formatting it is the recipe's job, because `str()` on an object renders
   * empty. (`seenCount` is a column on the row, never payload — dropped.)
   */
  'gate-enrichment': {
    humanSummary: (ctx) => {
      const spec = ctx.payload.stepSpec
      const cmd = spec ? [spec.cmd, ...spec.args].join(' ') : ''
      return cmd
        ? `Decide whether to add \`${cmd}\` as a standing automated check — this error pattern keeps recurring. Approve it or retire the pattern.`
        : 'Decide whether to add a proposed automated check for a recurring error pattern — approve it or retire the pattern.'
    },
    humanDetail: (ctx) => {
      const spec = ctx.payload.stepSpec
      return {
        raisedAt: ctx.raisedAt,
        entityId: ctx.entityId,
        signature: ctx.payload.signature,
        candidateCheck: spec
          ? `${[spec.cmd, ...spec.args].join(' ')} (dir: ${spec.dir ?? '.'})`
          : 'none — no runnable check could be encoded for this signature',
        encodableFamily: ctx.payload.encodableFamily ?? 'command',
        failingStep: ctx.payload.failingStep,
        originTaskId: ctx.payload.originTaskId ?? '',
        writerTaskId: ctx.payload.writerTaskId ?? '',
      }
    },
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
        ? `Decide whether to retire the auto-added check for "${sig}" — it has passed ${count} consecutive runs and the issue may be resolved.`
        : `Decide whether to retire an auto-added check that has passed many consecutive runs — the issue it was tracking may be resolved.`
    },
    humanDetail: (ctx) => {
      const spec = ctx.payload['stepSpec']
      return {
        raisedAt: ctx.raisedAt,
        entityId: ctx.entityId,
        signature: str(ctx.payload['signature']),
        passCount: ctx.payload['passCount'],
        candidateCheck: spec
          ? `${[spec.cmd, ...spec.args].join(' ')} (dir: ${spec.dir ?? '.'})`
          : 'none',
      }
    },
    verbs: [
      { op: 'enrich-retire', label: 'Retire check', style: 'default' },
    ],
  },

  // ── Budget ────────────────────────────────────────────────────────────────

  // family: spend-provider
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

  // family: spend-provider
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
      const workflow = str(ctx.payload['workflow']) || ctx.entityId
      return `You have a suggestion to consider — a quality scorer for "${workflow}" is proposed. Accept it to start tracking quality automatically, or dismiss it.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      workflow: str(ctx.payload['workflow']),
      scorerId: str(ctx.payload['scorerId']),
    }),
    verbs: [
      { op: 'scorer-accept', label: 'Accept scorer', style: 'primary' },
      { op: 'scorer-dismiss', label: 'Dismiss suggestion', style: 'default' },
    ],
  },

  'promotion-decision': {
    humanSummary: (ctx) => {
      const decision = str(ctx.payload['decision'])
      const workflow = str(ctx.payload['workflow']) || ctx.entityId
      if (decision === 'promote') {
        return `Decide whether to promote "${workflow}" to the default — it is performing better than before.`
      } else if (decision === 'retire') {
        return `Decide whether to retire "${workflow}" — it is performing worse than before.`
      }
      return `You need to decide what to do with "${workflow}" — review the benchmark results and choose.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      workflow: str(ctx.payload['workflow']),
      decision: str(ctx.payload['decision']),
      ledgerId: str(ctx.payload['ledgerId']),
    }),
    verbs: [
      { op: 'promote-workflow', label: 'Promote', style: 'primary' },
      { op: 'retire-workflow', label: 'Retire', style: 'destructive' },
    ],
  },

  'workflow-draft-pending': {
    humanSummary: (ctx) => {
      const name = str(ctx.payload['workflowName']) || ctx.entityId
      return `You need to approve a new workflow "${name}" before it can run — review it and approve or reject.`
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
      return `You need to decide on a helper tool "${helperKey}" — review the benchmark and choose to promote or reject it.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      helperKey: str(ctx.payload['helperKey']),
      attemptId: str(ctx.payload['attemptId']),
      before: ctx.payload['before'],
      after: ctx.payload['after'],
    }),
    verbs: [
      { op: 'approve-tool', label: 'Promote helper', style: 'primary' },
      { op: 'reject-tool', label: 'Reject helper', style: 'destructive' },
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
      const inFlightStatusCount = ctx.payload['inFlightStatusCount']
      const activeWorkerCount = ctx.payload['activeWorkerCount']
      const implementCap = ctx.payload['implementCap']
      // When the DB shows in-flight-status rows saturating the implement cap
      // but the live tracker holds zero jobs, the queue isn't actually
      // saturated with real work — it's phantom in-flight rows left by a
      // prior daemon (e.g. after `mars daemon restart`). Name that cause
      // instead of blaming the queued task or a vague "task processor stuck".
      if (
        typeof inFlightStatusCount === 'number' &&
        activeWorkerCount === 0 &&
        typeof implementCap === 'number' &&
        inFlightStatusCount >= implementCap
      ) {
        return `Task ${taskId} has been waiting in the queue for ${ageMin} min — ${inFlightStatusCount} task(s) are stuck in an in-flight status with 0 live jobs running, saturating the worker pool. Run \`mars sync\` to re-queue the phantom rows — nothing is fixing this automatically, you need to look at it.`
      }
      return `Task ${taskId} has been waiting in the queue for ${ageMin} min — the worker slots may be full or the task processor may be stuck — nothing is fixing this automatically, you need to look at it.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      taskId: str(ctx.payload['taskId']),
      queuedAgeMs: ctx.payload['queuedAgeMs'],
      activeWorkerCount: ctx.payload['activeWorkerCount'],
      implementCap: ctx.payload['implementCap'],
      inFlightStatusCount: ctx.payload['inFlightStatusCount'],
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

  // family: spend-provider
  'spend-control-notice': {
    humanSummary: (ctx) => {
      const direction = str(ctx.payload['direction'])
      return direction === 'paused'
        ? 'Mars paused the work queue because token spend crossed the configured threshold — no action needed from you.'
        : 'Mars resumed the work queue — spend dropped back below the threshold. No action needed from you.'
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
        ? `Pick whether to run task ${taskId} now — provider usage pressure has cleared and it is ready to go.`
        : `Decide if you want to run task ${taskId} sooner — Mars has deferred it while provider usage is high.`
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
    humanSummary: (_ctx) =>
      'Mars is monitoring a task approaching its retry limit — no action needed from you.',
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

  'arc-superseded-on-main': {
    humanSummary: (ctx) => {
      const originId = str(ctx.payload['originId']) || ctx.entityId
      const sha = str(ctx.payload['supersededBySha'])
      return sha
        ? `Mars dropped task group ${originId} — the same work already landed on the main branch (${sha.slice(0, 8)}). No action needed from you.`
        : `Mars dropped task group ${originId} — the same work already landed on the main branch. No action needed from you.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      originId: str(ctx.payload['originId']),
      supersededBySha: str(ctx.payload['supersededBySha']),
    }),
    verbs: [],
  },

  'e2e-tooling-missing': {
    humanSummary: (ctx) => {
      const missing = ctx.payload['missing']
      const count = Array.isArray(missing) ? missing.length : 0
      return count > 0
        ? `E2E tooling is not set up (${count} prerequisite${count === 1 ? '' : 's'} missing) — the task groups are running without end-to-end tests — nothing is fixing this automatically, you need to set it up.`
        : 'E2E tooling is not set up — the task groups are running without end-to-end tests — nothing is fixing this automatically, you need to set it up.'
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      missing: ctx.payload['missing'],
      setupSteps: ctx.payload['setupSteps'],
      mostRecentArcId: str(ctx.payload['mostRecentArcId']),
    }),
    verbs: [],
  },

  // family: daemon-health
  'low-disk-space': {
    humanSummary: (ctx) => {
      const freeMiB = typeof ctx.payload['freeBytes'] === 'number'
        ? Math.round((ctx.payload['freeBytes'] as number) / (1024 * 1024))
        : '?'
      // Disk-guard rows never pause dispatch via the PauseController (the guard
      // refuses individual dispatches, not the whole queue).  Omit any
      // "dispatch is paused" clause; the OPERATIONAL_ALERT_COPY renderer in
      // action-queue.ts owns that phrasing and has access to live pauseState.
      return `Low disk space: only ${freeMiB} MiB free — dispatches refused until space is reclaimed.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      freeBytes: ctx.payload['freeBytes'],
      thresholdBytes: ctx.payload['thresholdBytes'],
    }),
    verbs: [],
  },

  'baseline-broken': {
    humanSummary: (ctx) => {
      const gateName =
        typeof ctx.payload['failingGateName'] === 'string'
          ? ctx.payload['failingGateName']
          : 'unknown gate'
      const caughtTaskCount =
        typeof ctx.payload['caughtTaskCount'] === 'number' ? ctx.payload['caughtTaskCount'] : 0
      const caughtSuffix =
        caughtTaskCount > 0
          ? ` — caught ${caughtTaskCount} task failure${caughtTaskCount === 1 ? '' : 's'} that would otherwise look unrelated`
          : ''
      return `A check is failing on the main branch (${gateName})${caughtSuffix} — nothing is fixing this automatically, you need to look at it.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      failingGateName: ctx.payload['failingGateName'],
      installSignature: ctx.payload['installSignature'],
      caughtTaskCount: ctx.payload['caughtTaskCount'],
      caughtTaskIds: ctx.payload['caughtTaskIds'],
      // Tail-trimmed gate output excerpt for the VerifyExcerpt panel on the
      // triage card.  Full output is behind `mars action-queue show` (body).
      gateOutput: ctx.payload['gateOutput'],
    }),
    verbs: [
      {
        op: 'resume-dispatch',
        label: 'Resume dispatch',
        style: 'primary',
      },
    ],
  },

  'dirty-integration': {
    humanSummary: (ctx) => {
      const branch = str(ctx.payload['integrationBranch']) || 'main'
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      return `Task ${taskId} parked: branch '${branch}' has uncommitted changes — clean the branch then restart the task.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      taskId: str(ctx.payload['taskId']),
      integrationBranch: str(ctx.payload['integrationBranch']),
      dirtyPaths: ctx.payload['dirtyPaths'],
    }),
    verbs: [
      { op: 'restart', label: 'Restart task', style: 'primary' },
    ],
  },

  /**
   * Raised by the Steward's scheduled health pass when a check finds a
   * condition that requires operator attention and posture is `manual`.
   * Auto-clears on the next clean pass once the condition is gone.
   * The `conditionKey` payload field identifies which check raised this row
   * so the Steward can close it when the condition resolves.
   */
  // family: daemon-health
  'health-check-alert': {
    humanSummary: (ctx) => {
      const checkId = str(ctx.payload['conditionKey']) || ctx.entityId
      const message = str(ctx.payload['message']) || str(ctx.body)
      return message
        ? `Health check '${checkId}' requires attention: ${message}`
        : `Health check '${checkId}' requires operator action.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      conditionKey: str(ctx.payload['conditionKey']),
      message: str(ctx.payload['message']),
      checkDetails: ctx.payload['checkDetails'],
    }),
    verbs: [],
  },

  'fragmented-repo-layout': {
    humanSummary: (ctx) => {
      const workspace = str(ctx.payload['workspace']) || 'a workspace'
      return `Fragmented repo layout detected in ${workspace}: node_modules virtual store escaped the checkout — a fix task has been enqueued.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      workspace: ctx.payload['workspace'],
      virtualStoreDir: ctx.payload['virtualStoreDir'],
    }),
    verbs: [],
  },

  'recovery-abandoned': {
    humanSummary: (ctx) => {
      const fixTaskId = str(ctx.payload['fixTaskId']) || 'unknown'
      return `Recovery task ${fixTaskId} was manually dropped before it could run — the origin task needs manual resolution.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      fixTaskId: str(ctx.payload['fixTaskId']),
      originTaskId: str(ctx.payload['originTaskId']),
    }),
    verbs: [
      { op: 'restart', label: 'Restart (wipe & re-run)', style: 'primary' },
      { op: 'purge', label: 'Discard task', style: 'destructive' },
    ],
  },

  'mockup-ready': {
    humanSummary: (ctx) => {
      const proposalId = str(ctx.payload['proposalId']) || 'unknown'
      return `Mars has prepared a visual mockup for proposal ${proposalId} — this is informational, no action needed from you.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      proposalId: str(ctx.payload['proposalId']),
      taskId: str(ctx.payload['taskId']),
    }),
    verbs: [],
  },

  'qa-step-list-opt-in': {
    humanSummary: (_ctx) =>
      'Decide if you want to enable automatic QA step list generation for this project.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      arcId: str(ctx.payload['arcId']),
    }),
    verbs: [
      { op: 'accept', label: 'Enable', style: 'primary' },
      { op: 'reject', label: 'Skip', style: 'default' },
    ],
  },

  'qa-step-list-promote': {
    humanSummary: (_ctx) =>
      'Decide if you want to promote the QA step list to project documentation, or keep it as a task artifact only.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      arcId: str(ctx.payload['arcId']),
      manifestPath: str(ctx.payload['manifestPath']),
    }),
    verbs: [
      { op: 'accept', label: 'Promote to docs', style: 'primary' },
      { op: 'reject', label: 'Keep as arc artefact only', style: 'default' },
    ],
  },
} satisfies { [K in ActionQueueKind]: Omit<Recipe<K>, 'preloadedResponses' | 'kindClass'> }

/**
 * The Alert verbs are the existing source of truth for each recipe's available
 * daemon operations. A Notice presents the same operations as compact chips,
 * without AlertCard's destructive/primary styling or Dismiss/Snooze tail verbs.
 */
const REGISTRY: Record<ActionQueueKind, Recipe> = Object.fromEntries(
  Object.entries(RECIPE_DEFINITIONS).map((entry) => {
    // Each definition is typed against its own kind's payload contract, so the
    // entries union is not directly assignable to the kind-agnostic `Recipe`.
    // Erasing to it here is the same widening the outer cast already performs:
    // callers reach recipes through `lookupRecipe(kind)`, which hands back a
    // row's unvalidated `Record<string, unknown>` payload either way.
    const [kind, recipe] = entry as [ActionQueueKind, Omit<Recipe, 'preloadedResponses' | 'kindClass'>]
    return [
      kind,
      {
        ...recipe,
        // Derived here rather than declared per-entry so definitions stay
        // compact and the classification stays in sync with action-queue-kinds.ts.
        kindClass: classifyKind(kind),
        preloadedResponses: (ctx: RecipeContext) =>
          (typeof recipe.verbs === 'function' ? recipe.verbs(ctx) : recipe.verbs)
            .filter(({ op }) => classifyMarsVerb(op) === 'safe')
            .map(({ op, label }) => ({
              id: op,
              label,
              target: { type: 'verb' as const, op, entityId: ctx.entityId },
            })),
      },
    ]
  }),
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

