/**
 * The Notice registry — the single place a notice kind is turned into
 * something the operator can read and act on.
 *
 * Each kind declares four facets:
 *
 * - `render`      — one first-person sentence saying what changed and why.
 * - `actionable`  — whether this notice requires operator attention (true) or
 *                   is purely informational (false). Actionable notices gate
 *                   chat placement; non-actionable ones are eligible to be
 *                   coalesced into a single collapsed health notice.
 * - `lever`       — the Autonomy level lever that produced the behaviour, if any.
 *                   Its presence is what lets the announcement carry its own
 *                   off-switch instead of sending the operator hunting settings.
 * - `offers`      — the Offer set: the chips shown under the body, which is also
 *                   the vocabulary free text is matched against.
 * - `collapseKey` — when present on a non-actionable notice, notices sharing
 *                   this key may be coalesced into one collapsed health notice
 *                   per condition, suppressing the individual items.
 *
 * Keeping the facets together is the point. A kind that renders copy but
 * forgets its lever produces exactly the failure this feature exists to fix:
 * Mars announcing something the operator cannot stop.
 */

import { z } from 'zod'
import type { PreloadedResponse } from './chat-store'

/** Kinds of autonomous, template-authored conversation Notices. */
export const AutonomousNoticeKindSchema = z.enum([
  'recipe.auto-applied',
  'failure.batch',
  'session.idle-proposal',
  'suggestion.codegraph',
  'observation.manual-push',
  'trend.token-spend',
  'gate.main-broken',
  'merge.operator-auto-commit',
  'steward.prompt-optimizer-ack',
  'steward.prompt-optimization',
  'steward.workflow-patch',
  'steward.runtime-tune',
])

export type AutonomousNoticeKind = z.infer<typeof AutonomousNoticeKindSchema>

/**
 * Autonomy levers named by the registry. Each one gates a distinct unprompted
 * behaviour, so silencing one never silences another.
 */
export const STEWARD_RUNTIME_TUNE_LEVER = 'steward_runtime_tune' as const
export const IDLE_PROPOSAL_OFFER_LEVER = 'idle_proposal_offer' as const
export const CODEGRAPH_SUGGESTION_LEVER = 'codegraph_suggestion' as const
export const UNVERIFIED_COMMITS_LEVER = 'unverified_commits' as const
export const ARCHITECTURE_REPORT_LEVER = 'architecture_report' as const
export const STEWARD_PROMPT_OPTIMIZER_LEVER = 'steward_prompt_optimizer' as const
export const STEWARD_WORKFLOW_PATCH_LEVER = 'steward_workflow_patch' as const

export interface AutonomousNoticePayloads {
  'recipe.auto-applied': { recipeId: string; failureKind: string; targetTaskId: string }
  'failure.batch': { taskCount: number; cause: string }
  /** Nothing is in flight and a draft proposal is waiting to be shaped. */
  'session.idle-proposal': { proposalId: string; title: string }
  /**
   * No graph traversal configured. `tasksRun` is the honest cost proxy: Mars
   * cannot count a Worker's file reads, but it knows how many Workers it sent
   * into the codebase to find their own way around.
   */
  'suggestion.codegraph': { tasksRun: number; windowDays: number }
  /** Commits reaching the integration branch outside the pipeline. */
  'observation.manual-push': { commits: number; marsCommits: number; windowDays: number; branch: string }
  /**
   * Token spend rose measurably against the operator's own baseline. Mars
   * reports the trend it measured and offers to go find the cause — it does
   * not claim to have written a report it has not written.
   */
  'trend.token-spend': { changePct: number; windowDays: number }
  /** The integration branch is failing, so incoming work cannot verify. */
  'gate.main-broken': { failingCheck: string; blockedTasks: number }
  /**
   * Mars committed the operator's own uncommitted edits on the integration
   * branch so a merge could land (ADR-0100). The sha is the whole point: it
   * is how the operator finds work they did not commit themselves. `files` is
   * the list of paths that were staged and committed — surfaced so the
   * operator can verify exactly what was captured.
   */
  'merge.operator-auto-commit': {
    taskId: string
    branch: string
    commitSha: string
    files: readonly string[]
  }
  /**
   * The steward prompt optimizer applied an update to a worker's prompt.
   * `workerId` is the worker whose prompt changed; `reason` is a brief phrase
   * explaining the finding; `entryId` is the steward-ledger row the operator
   * can revert against.
   */
  'steward.prompt-optimizer-ack': {
    workerId: string
    reason: string
    entryId: string
  }
  /**
   * A routine confirmation that the steward prompt optimizer autonomously applied
   * a prompt edit. Carries no action chips — purely informational. `ledgerId` is
   * the steward-ledger row that records the change and enables reverting it.
   */
  'steward.prompt-optimization': {
    ledgerId: string
  }
  /**
   * The steward has drafted a patch to a workflow file and is asking the
   * operator to review it before anything is applied.
   * `proposalId` is the proposals-table row; `path` is the target file
   * (within `.mars/workflows/`); `diff` is the unified diff text.
   */
  'steward.workflow-patch': {
    path: string
    diff: string
    proposalId: string
  }
  /**
   * The Steward autotuner changed the implement cap — bumped it to absorb a
   * sustained backlog, or shed it in response to memory/process pressure.
   * `from` and `to` are the cap values before and after the change; `reason`
   * is a short operator-facing phrase explaining why the change was made (e.g.
   * "the backlog was sustained", "the host was swapping memory").
   *
   * This notice uses a `dedupKey` so rapid successive changes are folded into
   * one row rather than flooding the conversation.
   */
  'steward.runtime-tune': {
    from: number
    to: number
    reason: string
  }
}

export type AutonomousConversationNoticeInput = {
  [Kind in AutonomousNoticeKind]: {
    kind: Kind
    payload: AutonomousNoticePayloads[Kind]
  }
}[AutonomousNoticeKind]

const sentenceValue = (value: string): string => value.replace(/[.!?]+/g, ' ').trim()

/**
 * What a Notice is doing with its sentence.
 *
 * An `announcement` reports something Mars already did, so it owes the
 * operator a reason — it always reads "I <did X> because <Y>". An `offer`
 * proposes something Mars has *not* done, so there is no cause to give and
 * demanding one would produce a lie.
 */
export type NoticeSpeechAct = 'announcement' | 'offer'

/** The facets of a notice kind. */
export interface NoticeKindEntry<Kind extends AutonomousNoticeKind> {
  act: NoticeSpeechAct
  /**
   * Whether this notice requires operator attention.
   *
   * `true`  — actionable: an operator decision, blocker, or reusable context;
   *            chat placement is granted for this notice.
   * `false` — non-actionable: purely informational; eligible to be coalesced
   *            into a single collapsed health notice per `collapseKey`.
   */
  actionable: boolean
  render: (payload: AutonomousNoticePayloads[Kind]) => string
  /** The Autonomy level lever this behaviour answers to, when it has one. */
  lever?: string
  offers: (payload: AutonomousNoticePayloads[Kind]) => PreloadedResponse[]
  /**
   * When present on a non-actionable notice, notices sharing this key are
   * eligible to be coalesced into one collapsed health notice per condition.
   * Ignored when `actionable` is `true`.
   */
  collapseKey?: string
  /**
   * When present, multiple firings of this notice kind are coalesced into a
   * single pending or delivered row. The function maps the payload to a stable
   * string key; all notices sharing that key within the coalesce window are
   * folded into one occurrence with an updated body instead of producing
   * separate chat messages.
   */
  dedupKey?: (payload: AutonomousNoticePayloads[Kind]) => string
}

/** "Noted" — the operator read it; nothing changes. */
const ack = (id = 'ack', label = 'Noted'): PreloadedResponse => ({
  id,
  label,
  target: { type: 'ack' },
})

/**
 * "Later" — the operator defers without committing; semantically distinct from
 * `ack` (acknowledgment) so the UI can style deferral differently from closure.
 */
const defer = (): PreloadedResponse => ({
  id: 'later',
  label: 'Later',
  target: { type: 'ack' },
})

/** The off-switch for `lever`, worded for the behaviour it silences. */
const silence = (lever: string, label: string, id = 'silence'): PreloadedResponse => ({
  id,
  label,
  target: { type: 'lever', name: lever, level: 'off' },
})

/**
 * A Notice with no lever and no action still gets an Offer set: acknowledging
 * is how an FYI closes.
 */
const ackOnly = (): PreloadedResponse[] => [ack()]

const REGISTRY: { [Kind in AutonomousNoticeKind]: NoticeKindEntry<Kind> } = {
  'recipe.auto-applied': {
    act: 'announcement',
    actionable: false,
    collapseKey: 'recipe-auto-applied',
    render: (p) =>
      `I applied recipe ${sentenceValue(p.recipeId)} to task ${sentenceValue(p.targetTaskId)} because it matched ${sentenceValue(p.failureKind)}.`,
    offers: () => ackOnly(),
  },
  'failure.batch': {
    act: 'announcement',
    actionable: true,
    render: (p) => {
      const tasks = p.taskCount === 1 ? '1 blocked task' : `${p.taskCount} blocked tasks`
      return `I am flagging ${tasks} because they share the same failure: ${sentenceValue(p.cause)}.`
    },
    offers: (p) => [
      {
        id: 'triage',
        label: 'Look into it',
        target: { type: 'subject', title: `Triage: ${sentenceValue(p.cause)}` },
      },
      defer(),
    ],
  },
  'session.idle-proposal': {
    act: 'offer',
    actionable: true,
    render: (p) =>
      `Nothing on my side — want to grill "${sentenceValue(p.title)}"?`,
    lever: IDLE_PROPOSAL_OFFER_LEVER,
    offers: (p) => [
      {
        id: 'grill',
        label: 'Grill it',
        target: { type: 'client', op: 'open-proposal-subject', entityId: p.proposalId },
      },
      ack('later', 'Later'),
      // Class-level off-switch: turns off idle-proposal offers entirely.
      silence(IDLE_PROPOSAL_OFFER_LEVER, 'Stop suggesting proposals', 'stop'),
      // Per-instance: dismisses only this proposal's offer, not the whole class.
      {
        id: 'never',
        label: 'Stop asking me that',
        target: { type: 'dismiss-notice', noticeKey: `idle-proposal:${p.proposalId}` },
      },
      // Class-level: turns the lever off so no more idle proposals surface.
      silence(IDLE_PROPOSAL_OFFER_LEVER, 'Stop suggesting these'),
    ],
  },
  'suggestion.codegraph': {
    act: 'offer',
    actionable: false,
    collapseKey: 'codegraph-suggestion',
    render: (p) =>
      `You have no graph traversal installed, so each of the ${p.tasksRun} tasks I ran over the last ${p.windowDays} days found its own way around by reading files — codegraph would answer the same questions for a fraction of the tokens.`,
    lever: CODEGRAPH_SUGGESTION_LEVER,
    offers: () => [
      {
        id: 'install',
        label: 'Install it',
        target: { type: 'subject', title: 'Install codegraph' },
      },
      ack('later', 'Later'),
      silence(CODEGRAPH_SUGGESTION_LEVER, 'Stop suggesting this', 'never'),
      {
        id: 'why',
        label: 'Why AST traversal helps',
        target: {
          type: 'reference',
          url: 'https://tree-sitter.github.io/tree-sitter/using-parsers',
        },
      },
    ],
  },
  'observation.manual-push': {
    act: 'offer',
    actionable: true,
    render: (p) =>
      `Mars landed ${p.marsCommits} commits on ${sentenceValue(p.branch)}; ${p.commits} more arrived that have never been through verify.`,
    lever: UNVERIFIED_COMMITS_LEVER,
    offers: (p) => [
      {
        id: 'enqueue-verify',
        label: 'Verify them',
        target: { type: 'subject', title: `Run verify on unverified commits on ${sentenceValue(p.branch)}` },
      },
      silence(UNVERIFIED_COMMITS_LEVER, "Don't mention this again", 'never'),
    ],
  },
  'trend.token-spend': {
    act: 'announcement',
    actionable: false,
    collapseKey: 'token-spend-trend',
    render: (p) =>
      `I am flagging token spend because it rose ${p.changePct}% over the last ${p.windowDays} days against your own baseline.`,
    lever: ARCHITECTURE_REPORT_LEVER,
    offers: () => [
      {
        id: 'report',
        label: 'Write me a report',
        target: { type: 'subject', title: 'Why token spend rose' },
      },
      defer(),
      silence(ARCHITECTURE_REPORT_LEVER, 'Disable spend trend alerts', 'never'),
    ],
  },
  'gate.main-broken': {
    act: 'announcement',
    actionable: true,
    render: (p) => {
      const blocked = p.blockedTasks === 1 ? '1 incoming task' : `${p.blockedTasks} incoming tasks`
      return `I paused dispatch because ${sentenceValue(p.failingCheck)} is failing on the integration branch and blocking ${blocked}.`
    },
    offers: () => [
      {
        id: 'fix',
        label: 'Fix it',
        target: { type: 'subject', title: 'Fix the integration branch' },
      },
      ack(),
    ],
  },
  'merge.operator-auto-commit': {
    act: 'announcement',
    actionable: true,
    render: (p) => {
      const files = p.files.length === 1 ? '1 uncommitted file' : `${p.files.length} uncommitted files`
      return (
        `I committed ${files} of yours on ${sentenceValue(p.branch)} as ` +
        `${sentenceValue(p.commitSha).slice(0, 9)} because they were blocking the merge of ` +
        `${sentenceValue(p.taskId)}. ` +
        `To undo: \`git revert ${p.commitSha}\``
      )
    },
    // No `lever` facet: the off-switch here is the `operatorAutoCommit`
    // control lever (`mars operator set operator-auto-commit off`), not an
    // Autonomy level, and a lever-target chip writes Autonomy levels only —
    // offering one would be a button that changes nothing. The reply is the
    // honest gesture, so the Offer opens a Subject to carry it out.
    offers: (p) => [
      {
        id: 'revert',
        label: 'Undo this commit',
        // `verb` target: the daemon resolves this by running `git revert`
        // against the named commit. The entityId encodes both the sha and the
        // affected files so the handler can report exactly what it reverted.
        target: {
          type: 'verb',
          op: 'revert-auto-commit',
          entityId: JSON.stringify({ commitSha: p.commitSha, files: p.files }),
        },
      },
      {
        id: 'stop',
        label: 'Stop auto-committing',
        target: {
          type: 'subject',
          title: `Stop auto-committing my edits on ${sentenceValue(p.branch)}`,
        },
      },
      ack(),
    ],
  },
  'steward.prompt-optimizer-ack': {
    act: 'announcement',
    actionable: true,
    lever: STEWARD_PROMPT_OPTIMIZER_LEVER,
    render: (p) =>
      `I updated the ${sentenceValue(p.workerId)} worker prompt because ${sentenceValue(p.reason)}.`,
    offers: (p) => [
      {
        id: 'revert',
        label: 'Undo this change',
        target: {
          type: 'verb',
          op: 'revert-prompt-optimization',
          entityId: p.entryId,
        },
      },
      ack(),
      silence(STEWARD_PROMPT_OPTIMIZER_LEVER, 'Stop optimizing prompts', 'stop'),
    ],
  },
  'steward.prompt-optimization': {
    act: 'announcement',
    actionable: false,
    render: (p) => `I tightened the worker prompt because the optimizer applied a structural improvement (ledger ${p.ledgerId}).`,
    lever: undefined,
    offers: () => ackOnly(),
    dedupKey: () => 'steward-prompt-opt',
  },
  'steward.workflow-patch': {
    act: 'announcement',
    actionable: true,
    render: (p) =>
      `I drafted a workflow patch for ${sentenceValue(p.path)} because the steward identified an improvement.`,
    offers: (p) => [
      {
        id: 'review',
        label: 'Review it',
        target: { type: 'subject', title: `Workflow patch: ${p.path}` },
      },
    ],
  },
  'steward.runtime-tune': {
    act: 'announcement',
    actionable: false,
    /**
     * Fold repeated cap changes into one notice so the chat does not fill up
     * with incremental bumps on a sustained backlog. The dedupKey is fixed so
     * any update within the coalesce window replaces the existing row.
     */
    collapseKey: 'steward-runtime-tune',
    dedupKey: () => 'steward-runtime-tune',
    render: (p) => {
      const verb = p.from < p.to ? 'bumped' : 'shed'
      return `I ${verb} implement workers from ${p.from} to ${p.to} because ${sentenceValue(p.reason)}.`
    },
    lever: STEWARD_RUNTIME_TUNE_LEVER,
    offers: () => [
      ack(),
      silence(STEWARD_RUNTIME_TUNE_LEVER, 'Stop adjusting the cap', 'stop'),
    ],
  },
}

/**
 * Render an autonomous event without involving a provider. Every renderer is
 * deliberately a single first-person sentence that says what changed and why.
 */
export const renderConversationNotice = <Kind extends AutonomousNoticeKind>(
  kind: Kind,
  payload: AutonomousNoticePayloads[Kind],
): string => (REGISTRY[kind] as NoticeKindEntry<Kind>).render(payload)

/** The Offer set a notice kind stands behind. */
export const offersForConversationNotice = <Kind extends AutonomousNoticeKind>(
  kind: Kind,
  payload: AutonomousNoticePayloads[Kind],
): PreloadedResponse[] => (REGISTRY[kind] as NoticeKindEntry<Kind>).offers(payload)

/** The Autonomy level lever a notice kind answers to, when it has one. */
export const leverForConversationNotice = (kind: AutonomousNoticeKind): string | undefined =>
  REGISTRY[kind].lever

/** Whether a notice kind reports something done or proposes something to do. */
export const speechActForConversationNotice = (kind: AutonomousNoticeKind): NoticeSpeechAct =>
  REGISTRY[kind].act

/**
 * Whether a notice kind requires operator attention.
 *
 * Actionable notices gate chat placement. Non-actionable notices are eligible
 * to be coalesced into a single collapsed health notice per `collapseKey`.
 */
export const isActionableConversationNotice = (kind: AutonomousNoticeKind): boolean =>
  REGISTRY[kind].actionable

/**
 * The collapse key for a non-actionable notice kind, when coalescing is
 * applicable. Non-actionable notices sharing the same key are folded into one
 * collapsed health notice per condition. Returns `undefined` for actionable
 * notices and for non-actionable notices that are always shown individually.
 */
export const collapseKeyForConversationNotice = (kind: AutonomousNoticeKind): string | undefined =>
  REGISTRY[kind].actionable ? undefined : REGISTRY[kind].collapseKey

/**
 * The dedup key for a notice kind + payload, when the registry declares one.
 *
 * Multiple firings that resolve to the same key are coalesced into a single
 * pending or delivered row (see `postConversationNotice`). Returns `undefined`
 * for notice kinds that do not participate in deduplication.
 */
export const dedupKeyForNotice = <Kind extends AutonomousNoticeKind>(
  kind: Kind,
  payload: AutonomousNoticePayloads[Kind],
): string | undefined => {
  const entry = REGISTRY[kind] as NoticeKindEntry<Kind>
  return entry.dedupKey?.(payload)
}
