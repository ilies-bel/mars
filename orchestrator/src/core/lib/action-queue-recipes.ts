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

import { classifyKind, DERIVED_KINDS, type ActionQueueClass, type ActionQueueKind } from './action-queue-kinds'

export type { ActionQueueClass } from './action-queue-kinds'
import {
  awaitingHumanSituation,
  type LeaseExpiredPayload,
  type LeaseParkPayload,
  type PayloadFor,
} from './action-queue-payloads'
import { classifyMarsVerb } from './chat-mars-verbs'
import { resolveFailureKind } from './failure-kinds'

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
  /**
   * Whether the task's worktree directory exists on disk, or `null` when not
   * probed (beyond MAX_DIRTY_PROBES cap, or no worktree_path stored). `null`
   * means "unknown", NOT "present" — never treat null as true (ADR-0057).
   * Do NOT infer this from `worktreeDirtyCount === null`: that is also null for
   * rows beyond the probe cap, so conflating the two masks a missing worktree.
   */
  worktreeExists?: boolean | null
  /**
   * Real (human/coder-authored) commits the task's branch holds ahead of the
   * integration branch, or `null` when not probed (beyond MAX_DIRTY_PROBES or
   * repoRoot absent). `null` means "unknown", NOT "zero" — never treat null as
   * "nothing to lose" (same ADR-0057 rule as worktreeDirtyCount).
   */
  realCommitsAhead?: number | null
  /**
   * Human-readable consequence string for the Restart action when commits are
   * at risk — e.g. "Restart discards 2 commits on task/mars-3176234e."
   * Absent when `realCommitsAhead` is 0 or null.
   */
  restartConsequence?: string
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
  /**
   * When true, the client must present a confirmation dialog before executing
   * the operation. Intended for destructive, irreversible ops (restart, purge)
   * where accidental clicks would discard work without warning.
   * Matches `alertVerbSchema.needsConfirm` (`ui/src/shared/schemas.ts`).
   */
  needsConfirm?: boolean
}

/**
 * A server-defined decision button emitted on `ActionQueueRow.decisions`.
 * Shape mirrors `zDecision` (`ui/src/shared/schemas.ts`) — every field here
 * MUST be accepted by that Zod schema, because an unknown field fails
 * validation for the entire row.
 */
export type RecipeDecision = {
  label: string
  endpoint: string
  payload: Record<string, unknown>
  /** Visual style hint — same vocabulary as `RecipeVerb.style`. */
  style?: 'primary' | 'destructive' | 'default' | 'snooze'
  secondary?: { kind: 'teach-recipe' | 'scope-choice'; prompt: string }
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
  /**
   * Server-defined decision buttons for this kind. Each entry maps to exactly
   * one button on the client (no client-side switch on failure kind required).
   * When present, these are emitted verbatim on the `ActionQueueRow.decisions`
   * field; absent means `decisions: []`. The `style` field mirrors
   * `RecipeVerb.style` and MUST use the same vocabulary so the client's
   * `zDecision.style` enum accepts it without translation.
   */
  decisions?: RecipeDecision[] | ((ctx: RecipeContext<K>) => RecipeDecision[])
  /**
   * Optional bulk-resolve verb for a cause-group card whose members all share
   * this kind. When present, the group card shows this as its primary action
   * (e.g. "Retry all 18") with Snooze demoted to secondary. When absent, only
   * Snooze is offered — no invented action.
   *
   * The verb belongs here (shared layer, HR-3) so the CLI can expose the same
   * bulk action later without duplicating the recipe lookup.
   *
   * Which kinds could sensibly declare one:
   * - `slice-failed` ✓ — re-slice is idempotent; transient outage is the
   *   dominant cause of a batch failure.
   * - `env-incident` — restart-task per member is safe; not added yet because
   *   env incidents rarely form large batches.
   * - `failed` — restart/continue per member is safe but destructive; needs
   *   a per-member worktree-dirty check before bulk-restart is reasonable.
   */
  bulkResolveVerb?: RecipeVerb
  /**
   * Optional recipe-level override for the operator-facing goal string shown on
   * the action-queue row.
   *
   * Return a non-null string to supply `operatorGoal` directly. Return `null`
   * to let the view builder fall back to its default entity-based resolution
   * chain (task intent for task-failure kinds; absent for everything else).
   *
   * Most recipes do not need this — it is reserved for kinds whose primary
   * entity is not a task and therefore cannot be resolved via `taskById`. The
   * canonical example is `slice-failed`, where the entity is a PRD (proposal):
   * `taskById` never holds a proposal, so the default chain yields `null`.
   */
  operatorGoal?: (ctx: RecipeContext<K>) => string | null
  /**
   * Optional recipe-level accessor for the entity's human-readable title.
   *
   * Return a non-null string to supply the entity title the UI uses to name
   * members in a cause-group drill-down (e.g. the PRD's full title rather than
   * its truncated slug id). Return `null` when the kind has no independent
   * entity title (task-backed rows surface their goal via `arcGoal` instead).
   *
   * Most recipes do not need this — it is reserved for kinds whose entity is a
   * named artifact (a PRD, a workflow, etc.). The canonical example is
   * `slice-failed`, where the entity is a proposal and the title comes from
   * `payload.proposalTitle`.
   *
   * The value is available at raise time and is carried in the payload, so
   * this accessor never performs a lookup: it reads a field that the raiser
   * already stamped.
   */
  entityTitle?: (ctx: RecipeContext<K>) => string | null
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
 *
 * `verify-uncovered` is included because it is a stored operator-decision row
 * and the operator may choose to dismiss the coverage gap rather than add a
 * gate — dismissal is a valid resolution alongside adding a check.
 */
const GENERIC_DISMISS_KINDS = new Set<string>(['draft-proposal', 'verify-uncovered'])

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
      // When the failure is a verify gate, name the specific gate that failed
      // so the operator can act without opening a separate terminal. Example:
      //   "…the `test` verify gate failed…" vs "…got stuck…"
      const sig = str(ctx.payload['failureSignature'])
      const gateHint =
        sig.startsWith('verify:') && sig !== 'verify:step-threw'
          ? ` The \`${sig.slice('verify:'.length)}\` verify gate failed.`
          : ''
      const base =
        `A task got stuck.${gateHint} Mars used up its automatic retry — nothing is fixing this now, you need to decide what to do (${taskId}).`
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
    humanDetail: (ctx) => {
      const realCommitsAhead =
        typeof ctx.payload['realCommitsAhead'] === 'number'
          ? (ctx.payload['realCommitsAhead'] as number)
          : null
      const branch =
        typeof ctx.payload['branch'] === 'string'
          ? (ctx.payload['branch'] as string)
          : null
      const worktreeExists =
        typeof ctx.payload['worktreeExists'] === 'boolean'
          ? (ctx.payload['worktreeExists'] as boolean)
          : null
      const detail: RecipeHumanDetail = {
        raisedAt: ctx.raisedAt,
        entityId: ctx.entityId,
        failureSignature: str(ctx.payload['failureSignature']),
        errorExcerpt: str(ctx.payload['errorExcerpt']),
        ...(branch !== null ? { branch } : {}),
        worktree: str(ctx.payload['worktree']),
        ...(worktreeExists !== null ? { worktreeExists } : {}),
        worktreeDirtyCount:
          typeof ctx.payload['worktreeDirtyCount'] === 'number'
            ? (ctx.payload['worktreeDirtyCount'] as number)
            : null,
        ...(realCommitsAhead !== null ? { realCommitsAhead } : {}),
      }
      if (realCommitsAhead !== null && realCommitsAhead > 0 && branch !== null) {
        detail['restartConsequence'] =
          `Restart discards ${realCommitsAhead} commit${realCommitsAhead === 1 ? '' : 's'} on ${branch}.`
      }
      return detail
    },
    /**
     * Decision table — worktreeExists gates continue; commit counts decide the
     * rest. Mirrors classifyCommitsAheadForBranch in continue-task.ts — does
     * NOT re-derive, reads from probed payload fields set by derived-conditions.
     *
     *  worktreeExists=null (not probed)
     *    → no safe-verb claim; destructive pair still confirm-gated
     *
     *  worktreeExists=true, recoveryExhausted=false
     *    → continue (primary) — resumes the coder on the worktree
     *
     *  worktreeExists=true, recoveryExhausted=true, realCommitsAhead > 0
     *    → remerge (primary)
     *
     *  worktreeExists=true, recoveryExhausted=true, realCommitsAhead=0, checkpoints > 0
     *    → copy supersede command
     *
     *  worktreeExists=true, recoveryExhausted=true, realCommitsAhead=0, checkpoints=0
     *    → restart is the only forward path
     *
     *  worktreeExists=false, realCommitsAhead > 0 (either exhausted state)
     *    → remerge (primary) — mars remerge does not need the worktree
     *
     *  worktreeExists=false, realCommitsAhead=0, checkpoints > 0
     *    → copy supersede command
     *
     *  worktreeExists=false, realCommitsAhead=0, checkpoints=0
     *    → restart is the only forward path
     *
     *  worktreeExists=false, realCommitsAhead=null (not probed)
     *    → no safe-verb claim
     *
     * Restart is ALWAYS appended as destructive + needsConfirm. Its label
     * names the commit count it would discard when commits are at risk, the
     * same way `recovery-abandoned` does (the correct pattern).
     */
    verbs: (ctx) => {
      const recoveryExhausted = ctx.payload['recoveryExhausted'] === true
      const worktreeExists =
        typeof ctx.payload['worktreeExists'] === 'boolean'
          ? (ctx.payload['worktreeExists'] as boolean)
          : null
      const realCommitsAhead =
        typeof ctx.payload['realCommitsAhead'] === 'number'
          ? (ctx.payload['realCommitsAhead'] as number)
          : null
      const checkpointCommitsAhead =
        typeof ctx.payload['checkpointCommitsAhead'] === 'number'
          ? (ctx.payload['checkpointCommitsAhead'] as number)
          : null
      const branch =
        typeof ctx.payload['branch'] === 'string'
          ? (ctx.payload['branch'] as string)
          : null
      const taskId =
        typeof ctx.payload['taskId'] === 'string'
          ? (ctx.payload['taskId'] as string)
          : ctx.entityId

      const verbs: RecipeVerb[] = []

      if (worktreeExists === null) {
        // Not probed (beyond MAX_DIRTY_PROBES cap or repoRoot absent) — cannot
        // claim any safe verb. The destructive pair below still requires confirmation.
      } else if (worktreeExists) {
        // Worktree exists. Continue is safe when recovery has not been exhausted.
        // When exhausted, the coder cannot run there again; fall through to the
        // commits-ahead classification to determine what can be salvaged.
        if (!recoveryExhausted) {
          verbs.push({ op: 'continue', label: 'Resume on existing worktree', style: 'primary' })
        } else if (realCommitsAhead === null) {
          // Not probed — cannot claim any safe verb.
        } else if (realCommitsAhead > 0) {
          const n = realCommitsAhead
          verbs.push({
            op: 'remerge',
            label: `Re-verify and merge ${n} commit${n === 1 ? '' : 's'}`,
            style: 'primary',
          })
        } else if (checkpointCommitsAhead !== null && checkpointCommitsAhead > 0) {
          verbs.push({
            op: 'copy',
            label: 'Copy supersede command',
            style: 'default',
            hint: `mars task add --supersede ${taskId} --prompt-file <path>`,
          })
        }
        // else: exhausted + 0 real + 0 checkpoint → restart is the only forward
        // path; the destructive pair below communicates this.
      } else {
        // Worktree missing (worktreeExists === false). `mars continue` requires
        // the worktree to be on disk — without it the operation hard-errors or
        // silently degrades to a destructive restart. Real commits on the branch
        // are still accessible via `mars remerge`, which does not need the
        // worktree directory. Decision is based on commit counts alone.
        if (realCommitsAhead === null) {
          // Not probed — cannot claim any safe verb.
        } else if (realCommitsAhead > 0) {
          const n = realCommitsAhead
          verbs.push({
            op: 'remerge',
            label: `Re-verify and merge ${n} commit${n === 1 ? '' : 's'}`,
            style: 'primary',
          })
        } else if (checkpointCommitsAhead !== null && checkpointCommitsAhead > 0) {
          verbs.push({
            op: 'copy',
            label: 'Copy supersede command',
            style: 'default',
            hint: `mars task add --supersede ${taskId} --prompt-file <path>`,
          })
        }
        // else: missing worktree + 0 real + 0 checkpoint → restart is the only
        // forward path; the destructive pair below communicates this.
      }

      // Restart label names the commit count it would discard when commits are
      // at risk — an operator reading the label cannot miss what Restart deletes.
      const restartLabel =
        realCommitsAhead !== null && realCommitsAhead > 0 && branch !== null
          ? `Restart — discards ${realCommitsAhead} commit${realCommitsAhead === 1 ? '' : 's'} on ${branch}`
          : 'Restart'

      verbs.push({ op: 'restart', label: restartLabel, style: 'destructive', needsConfirm: true })
      verbs.push({ op: 'purge', label: 'Delete task', style: 'destructive', needsConfirm: true })

      return verbs
    },
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
    verbs: [{ op: 'restart', label: 'Restart chain', style: 'destructive' }],
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
      const downtimeMs = typeof ctx.payload['downtimeMs'] === 'number' ? ctx.payload['downtimeMs'] : null
      // Express downtime as a human-readable duration (same convention as daemon-outage).
      const downtimeSummary = downtimeMs !== null
        ? `~${Math.round(downtimeMs / 60_000)} min`
        : 'an unknown period'
      return `The background engine stopped and was down for ${downtimeSummary}. It is now running — verify it is healthy and dismiss this alert.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      pid: ctx.payload['pid'],
      startedAt: str(ctx.payload['startedAt']),
      stoppedAt: str(ctx.payload['stoppedAt']),
      downtimeMs: ctx.payload['downtimeMs'],
      crashDetectedAt: str(ctx.payload['crashDetectedAt']),
    }),
    verbs: [{ op: 'dismiss-daemon-died', label: 'Dismiss', style: 'primary' }],
  },

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
      return `No activity in this task's workspace for ${ageText}${statusText} (${taskId}).`
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
    verbs: [{ op: 'restart', label: 'Restart', style: 'destructive' }],
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
      { op: 'restart', label: 'Restart', style: 'destructive' },
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
      // 'grill' is intentionally absent: the UI's drawer "Shape into PRD" button
      // and the `/mars:grill <id>` clipboard command are the intended paths for
      // opening a grill session. Emitting 'grill' here would produce a verb with
      // no registered daemon handler (POST /actions/grill/:id → 404), turning a
      // deliberate UX into a dead button for any surface that renders recipe verbs.
      { op: 'promote', label: 'Promote & enqueue', style: 'default' },
    ],
  },

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

  'slice-failed': {
    humanSummary: () =>
      'Mars could not turn this PRD into tasks — inspect the PRD, then slice it again when ready.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      errorExcerpt: str(ctx.payload['error']),
    }),
    // The entity for slice-failed is a proposal ID, not a task ID, so the view
    // builder's default taskById resolution chain yields null. Declare
    // operatorGoal here so the PRD title (carried in the payload since the
    // raiser always stores it) reaches the operator without a task lookup.
    operatorGoal: (ctx) => str(ctx.payload['proposalTitle']) || null,
    // entityTitle carries the PRD's human-readable name so the UI can label
    // group members without parsing it back out of the body prose.
    entityTitle: (ctx) => str(ctx.payload['proposalTitle']) || null,
    verbs: [],
    bulkResolveVerb: { op: 'proposal.slice', label: 'Retry', style: 'primary' as const },
  },

  'slicer-transport-outage': {
    humanSummary: () =>
      'Provider was unreachable during slicing — affected PRDs will retry automatically when the provider is back.',
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      errorExcerpt: str(ctx.payload['error']),
    }),
    verbs: [
      { op: 'proposal.slice', label: 'Retry now', style: 'primary' as const },
      { op: 'snooze', label: 'Snooze', style: 'snooze' as const },
    ],
  },

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
          // The lease owner (a machine identifier) is kept in humanDetail where
          // readers who care about it can find it — the summary addresses the
          // operator directly instead.
          const p = ctx.payload as Partial<LeaseParkPayload>
          const step = str(p.stepName)
          return `Parked for you${step ? ` at step '${step}'` : ''} — signal done when you have finished.`
        }
        case 'lease-expired': {
          const p = ctx.payload as Partial<LeaseExpiredPayload>
          const age = typeof p.ageMinutes === 'number' ? ` ${p.ageMinutes} min` : ''
          return `The lease has been idle${age} — nobody is working on this task. Continue in the worktree or release it.`
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
    verbs: (ctx) => {
      const situation = awaitingHumanSituation(ctx.payload)
      if (situation !== 'lease-park') return []
      const p = ctx.payload as Partial<LeaseParkPayload>
      const step = str(p.stepName)
      if (step === 'merge-gate') {
        return [
          { op: 'approve-step', label: 'Approve and merge', style: 'primary' as const },
          { op: 'abort-release', label: 'Abort without merging', style: 'destructive' as const },
        ]
      }
      return [
        { op: 'approve-step', label: 'Mark step done', style: 'primary' as const },
      ]
    },
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
      { op: 'purge', label: 'Delete task', style: 'destructive' },
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
    verbs: [{ op: 'restart', label: 'Restart', style: 'destructive' }],
  },

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
    verbs: [
      { op: 'run-reflect', label: 'Run reflection', style: 'primary' },
      { op: 'stop-asking-reflect', label: 'Stop asking me that', style: 'default' },
    ],
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
      const gate = str(ctx.payload['gate'])
      const scope = str(ctx.payload['scope'])
      const name = str(ctx.payload['name'])
      const required = ctx.payload['required'] === true
      const verdict = str(ctx.payload['verdict'])
      // Prefer scope/name from the payload (added to the derived row so operators
      // never see a raw UUID in the headline). Fall back to verdict only if neither
      // is populated (e.g. rows from before the payload was enriched).
      const identity =
        scope && name && !(scope === gate && name === gate)
          ? `${scope}/${name}`
          : verdict || gate
      // A required gate that is quarantined silently disables a mandatory check:
      // every merge is proceeding without it. That is a headline fact, not a footnote.
      const requiredClause = required
        ? ` This is a required gate — while quarantined, every merge proceeds without this check.`
        : ''
      // The "Copy restore command" button carries the exact CLI form; the body
      // carries only the intent (DEC-18: no machine strings on card faces).
      return `The ${identity} check is quarantined and not enforcing.${requiredClause} Restore it once the underlying failure is fixed.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      gate: str(ctx.payload['gate']),
      scope: str(ctx.payload['scope']),
      name: str(ctx.payload['name']),
      required: ctx.payload['required'],
      // verdict (quarantine_signature) stays in the detail for anyone who needs
      // the raw failure fingerprint — kept out of the headline per DEC-18.
      verdict: str(ctx.payload['verdict']),
    }),
    // Restoring a gate re-runs that gate's own command — a full build or test
    // suite that can take minutes. The daemon's `gate-restore` op handler
    // (see HttpServerDeps.handleGateRestore and the POST /actions/gate-restore/:id
    // route via entityHandlers) runs it asynchronously and updates the gate's
    // health state without blocking the HTTP response. Primary style: it's the
    // row's whole reason to exist.
    // The copy verb surfaces the exact CLI command so the operator can run it
    // from a terminal — matching the hint text `mars verify-gate list` already
    // prints (`restore with: mars verify-gate restore <id>`).
    verbs: (ctx) => {
      const gate = str(ctx.payload['gate'])
      const restoreCmd = gate
        ? `mars verify-gate restore ${gate}`
        : 'mars verify-gate restore <id>'
      return [
        {
          op: 'gate-restore',
          label: 'Restore gate',
          style: 'primary' as const,
        },
        {
          op: 'copy',
          label: 'Copy restore command',
          style: 'default' as const,
          hint: restoreCmd,
        },
      ]
    },
  },

  'verify-uncovered': {
    humanSummary: (ctx) => {
      const scope = str(ctx.payload['scope']) || ctx.entityId
      // A bare '.' (repo-root scope) must never reach the operator.
      const scopeLabel = scope === '.' ? 'the repository root' : scope
      const proposed = ctx.payload['proposedGate'] as
        | { evidence?: string }
        | undefined
      // When a proposedGate is present the row was raised by a sweep (not a
      // merge). Use the sweep's own evidence rather than the merge wording.
      if (proposed && str(proposed['evidence'])) {
        return `Decide whether to add an automated check — Mars found: ${str(proposed['evidence'])}.`
      }
      return `Decide whether to add an automated check for ${scopeLabel} — a task merged without any check covering these changes.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      scope: str(ctx.payload['scope']),
      changedPaths: ctx.payload['changedPaths'],
      recipe: str(ctx.payload['recipe']),
    }),
    // The row asks one question — add a check for this scope, or decide none is
    // needed — so it carries both answers.
    //
    // `add-gate` creates the gate in one click straight from `proposedGate`, and
    // exists only when the raiser actually encoded a candidate check.
    // `copy` hands the operator the exact `mars verify-gate add` command pre-filled
    // from `proposedGate` when the raiser had enough context, or a minimal
    // `--scope` form when it did not — the escape hatch for adapting the command
    // rather than running it verbatim.
    // `dismiss-uncovered` records the negative answer: the gap is intentional.
    // Generic Dismiss is also appended by `getRecipeVerbs` (via GENERIC_DISMISS_KINDS).
    verbs: (ctx) => {
      const scope = str(ctx.payload['scope']) || '.'
      const proposed = ctx.payload['proposedGate'] as
        | { name?: string; cmd?: string; args?: string[]; scope?: string }
        | undefined
      const hint =
        proposed?.name && proposed?.cmd
          ? [
              'mars verify-gate add',
              `--scope ${str(proposed.scope) || scope}`,
              `--name ${proposed.name}`,
              `--cmd ${proposed.cmd}`,
              ...(Array.isArray(proposed.args) && proposed.args.length > 0
                ? ['--', ...proposed.args]
                : []),
            ].join(' ')
          : `mars verify-gate add --scope ${scope} --name <name> --cmd <cmd>`
      // 'Copy gate command' copies the ready-to-run mars verify-gate add command;
      // 'Add proposed gate' one-click-creates the gate from the proposedGate payload.
      // Labels are distinct so a cold reader can tell them apart.
      const baseVerbs: RecipeVerb[] = [{ op: 'copy', label: 'Copy gate command', style: 'primary', hint }]
      if (proposed) {
        baseVerbs.push({ op: 'add-gate', label: 'Add proposed gate', style: 'primary' })
      }
      baseVerbs.push({ op: 'dismiss-uncovered', label: 'No gate needed', style: 'primary' })
      return baseVerbs
    },
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
    // 'show-all' was removed: it had no registered daemon handler, and
    // derivedRowActions already provides a copy-action for 'mars operator'.
    verbs: [],
  },

  'signature-wave': {
    // Use ctx.title — the raiser (deriveSignatureWaveConditions) already writes a
    // cause-named title ("N tasks failed the same way: <warmTitle/errorHead> — one
    // fix likely unblocks all"). The HR-3 normalization in buildActionQueueView
    // promotes humanSummary to title when operationalCopy is null; returning ctx.title
    // here makes that promotion a no-op so the raiser's cause-named prose survives
    // to both the UI (`title`) and the CLI (`humanSummary || title`) surfaces.
    humanSummary: (ctx) => ctx.title,
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      signature: str(ctx.payload['signature']),
      caughtTaskCount: ctx.payload['caughtTaskCount'],
      caughtTaskIds: ctx.payload['caughtTaskIds'],
    }),
    // Offer a bulk-continue button only when every affected task can take it.
    // The wave entityId is a hash, not a task id, so task-scoped verbs like
    // restart/purge cannot be used here — the client dispatches continue per
    // member via the continue-wave op.
    verbs: (ctx) => {
      if (ctx.payload['bulkContinuable'] !== true) return []
      const count = typeof ctx.payload['caughtTaskCount'] === 'number'
        ? ctx.payload['caughtTaskCount']
        : (ctx.payload['caughtTaskIds'] as unknown[])?.length ?? 0
      return [{ op: 'continue-wave', label: `Continue all ${count}`, style: 'primary' as const }]
    },
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
      if (sig) {
        const checkLabel = resolveFailureKind(sig, '').warmTitle
        return `Decide whether to retire the auto-added check for "${checkLabel}" — it has passed ${count} consecutive runs and the issue may be resolved.`
      }
      return `Decide whether to retire an auto-added check that has passed many consecutive runs — the issue it was tracking may be resolved.`
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
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      return `Environmental failure on task ${taskId} — an infrastructure condition, not a code regression.`
    },
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      failureSignature: str(ctx.payload['signature']),
      taskId: str(ctx.payload['taskId']),
      envRestartCount: ctx.payload['envRestartCount'],
    }),
    verbs: [
      { op: 'restart', label: 'Restart', style: 'destructive' },
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
      { op: 'restart', label: 'Restart', style: 'destructive' },
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
      return `A check is failing on the main branch (${gateName})${caughtSuffix} — nothing is fixing this automatically, you need to look at it. Dispatch resumes on its own within about a minute of a commit landing that makes the check pass.`
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
    // No resume verb, and certainly not a PRIMARY one.
    //
    // `set dispatch on` clears the latch but does not fix the branch, so the
    // baseline health checker re-asserts the pause on its next run — and in
    // the window between, queued work is dispatched into a red integration
    // branch. This row made that the filled, recommended button, while the
    // Progress banner for the same condition said "Fix the gate to resume".
    // The queue was recommending the one action the docs single out as
    // harmful.
    //
    // There is nothing to click here: repair the gate and the daemon detects
    // the SHA advance and resumes by itself.
    verbs: [],
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
      { op: 'restart', label: 'Restart', style: 'destructive' },
    ],
  },

  /**
   * Raised by the Steward's scheduled health pass when a check finds a
   * condition that requires operator attention and posture is `manual`.
   * Auto-clears on the next clean pass once the condition is gone.
   * The `conditionKey` payload field identifies which check raised this row
   * so the Steward can close it when the condition resolves.
   */
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
    humanDetail: (ctx) => {
      const commitsAhead =
        typeof ctx.payload['commitsAhead'] === 'number'
          ? (ctx.payload['commitsAhead'] as number)
          : null
      const branch =
        typeof ctx.payload['branch'] === 'string' ? (ctx.payload['branch'] as string) : null
      const detail: RecipeHumanDetail = {
        raisedAt: ctx.raisedAt,
        entityId: ctx.entityId,
        fixTaskId: str(ctx.payload['fixTaskId']),
        originTaskId: str(ctx.payload['originTaskId']),
        ...(branch !== null ? { branch } : {}),
        ...(commitsAhead !== null ? { commitsAhead } : {}),
      }
      if (commitsAhead !== null && commitsAhead > 0 && branch !== null) {
        detail['restartConsequence'] = `Restart discards ${commitsAhead} commit${commitsAhead === 1 ? '' : 's'} on ${branch}.`
      }
      return detail
    },
    verbs: (ctx) => {
      const continuable = ctx.payload['continuable'] === true
      const commitsAhead =
        typeof ctx.payload['commitsAhead'] === 'number'
          ? (ctx.payload['commitsAhead'] as number)
          : null
      const branch =
        typeof ctx.payload['branch'] === 'string' ? (ctx.payload['branch'] as string) : null

      const verbs: RecipeVerb[] = []

      // `continue` is the safe default whenever the origin is continuable: it
      // resumes the coder on the existing worktree without discarding any commits.
      // Only suppress it when the origin is known to be non-continuable (exhausted
      // recovery slot, missing branch/worktree), in which case restart is the only
      // forward path and must be named explicitly.
      if (continuable) {
        verbs.push({ op: 'continue', label: 'Resume on existing worktree', style: 'primary' })
      }

      // Restart is always destructive and always requires confirmation.  When the
      // branch has commits ahead, say so in the label so the operator cannot miss
      // what they are about to lose.
      const restartLabel =
        commitsAhead !== null && commitsAhead > 0 && branch !== null
          ? `Restart — discards ${commitsAhead} commit${commitsAhead === 1 ? '' : 's'} on ${branch}`
          : 'Restart'

      verbs.push({ op: 'restart', label: restartLabel, style: 'destructive', needsConfirm: true })
      verbs.push({ op: 'purge', label: 'Delete task', style: 'destructive' })

      return verbs
    },
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

  'phantom-merge': {
    humanSummary: (ctx) =>
      `Task ${str(ctx.payload['taskId'])}: marked done but no merge SHA recorded — commits may not have landed on main`,
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      taskId: str(ctx.payload['taskId']),
      tombstonePath: str(ctx.payload['tombstonePath']),
    }),
    /**
     * Branch has unmerged commits (confirmed by `git cherry`). Offer Remerge
     * as the primary action; Supersede as the copy-to-clipboard fallback for
     * when the branch is stale and the operator wants a fresh task instead.
     * The server decides this based on kind ('phantom-merge' vs 'phantom-merge-unknown'),
     * so no client-side commit-count check is needed.
     */
    verbs: (ctx) => {
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      return [
        { op: 'remerge', label: 'Remerge — branch still has commits', style: 'primary' as const },
        {
          op: 'copy',
          label: 'Supersede — run from checkpoint',
          style: 'default' as const,
          hint: `mars task add --supersede ${taskId}`,
        },
      ]
    },
  },

  'phantom-merge-unknown': {
    humanSummary: (ctx) =>
      `Task ${str(ctx.payload['taskId'])}: null merge SHA, no surviving evidence — operator must verify manually`,
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      taskId: str(ctx.payload['taskId']),
      tombstonePath: str(ctx.payload['tombstonePath']),
    }),
    /**
     * No surviving branch or checkpoint refs — cannot determine if commits landed.
     * Only the Supersede copy verb is offered: operator verifies manually first,
     * then supersedes to carry any lost work forward from the checkpoint ref.
     */
    verbs: (ctx) => {
      const taskId = str(ctx.payload['taskId']) || ctx.entityId
      return [
        {
          op: 'copy',
          label: 'Supersede — run from checkpoint',
          style: 'default' as const,
          hint: `mars task add --supersede ${taskId}`,
        },
      ]
    },
  },

  'worktree-hook-trust-request': {
    humanSummary: (ctx) =>
      `mars.json setup hooks in ${str(ctx.payload['repoRoot'])} await operator trust grant`,
    humanDetail: (ctx) => ({
      raisedAt: ctx.raisedAt,
      entityId: ctx.entityId,
      taskId: str(ctx.payload['taskId']),
      repoRoot: str(ctx.payload['repoRoot']),
      commands: ctx.payload['commands'],
    }),
    verbs: [
      { op: 'accept', label: 'Grant trust (run hooks)', style: 'primary' },
      { op: 'reject', label: 'Deny (skip hooks)', style: 'default' },
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
 * Return the bulk-resolve verb declared by a kind's recipe, or null when the
 * kind declares none.
 *
 * Used by the group-building layer (`action-queue-group.ts`) so a cause-group
 * row carries the verb at the point of construction — the UI and CLI can then
 * render it without independently looking up the recipe.
 */
export const getGroupBulkVerb = (kind: ActionQueueKind): RecipeVerb | null =>
  REGISTRY[kind]?.bulkResolveVerb ?? null

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

