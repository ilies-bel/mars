/**
 * The Notice registry — the single place a notice kind is turned into
 * something the operator can read and act on.
 *
 * Each kind declares three facets:
 *
 * - `render`  — one first-person sentence saying what changed and why.
 * - `lever`   — the Autonomy level lever that produced the behaviour, if any.
 *               Its presence is what lets the announcement carry its own
 *               off-switch instead of sending the operator hunting settings.
 * - `offers`  — the Offer set: the chips shown under the body, which is also
 *               the vocabulary free text is matched against.
 *
 * Keeping the three together is the point. A kind that renders copy but
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
  'observation.manual-push': { commits: number; windowDays: number; branch: string }
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
  render: (payload: AutonomousNoticePayloads[Kind]) => string
  /** The Autonomy level lever this behaviour answers to, when it has one. */
  lever?: string
  offers: (payload: AutonomousNoticePayloads[Kind]) => PreloadedResponse[]
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
    render: (p) =>
      `I applied recipe ${sentenceValue(p.recipeId)} to task ${sentenceValue(p.targetTaskId)} because it matched ${sentenceValue(p.failureKind)}.`,
    offers: () => ackOnly(),
  },
  'failure.batch': {
    act: 'announcement',
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
    render: (p) =>
      `${p.commits} commits on ${sentenceValue(p.branch)} have never been through verify — I cannot vouch for them.`,
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
    render: (p) => {
      const files = p.files.length === 1 ? '1 uncommitted file' : `${p.files.length} uncommitted files`
      return (
        `I committed ${files} of yours on ${sentenceValue(p.branch)} as ` +
        `${sentenceValue(p.commitSha).slice(0, 9)} because they were blocking the merge of ` +
        `${sentenceValue(p.taskId)} — reply "stop auto-committing" and I will park the queue ` +
        `and leave your edits alone instead.`
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

