/**
 * "I committed your uncommitted edits on the integration branch for you."
 *
 * Mars writing a commit the operator did not ask for is the most invasive
 * thing the merge step does, so it is never silent: the moment a
 * `wip(operator)` commit lands (ADR-0100 slice 6), this speaks a Notice that
 * names the sha — so the edits are findable — and says how to stop it
 * happening again.
 *
 * Unlike the detectors next door (`manual-push.ts` and friends), there is
 * nothing to detect: the merge step tells us the commit happened. So this is
 * only the speaking half, and it is deliberately NOT gated on an autonomy
 * lever — the lever that governs this behaviour (`operatorAutoCommit`) gates
 * whether the commit is made at all, and a commit Mars made but did not
 * mention is exactly the failure the Notice exists to prevent.
 */

import { postConversationNotice } from '../conversation-delivery.js'
import { raiseActionQueueItem } from '../action-queue.js'

export interface OperatorAutoCommitNoticeInput {
  /** Task whose merge the auto-commit unblocked. */
  taskId: string
  /** The integration branch the commit landed on. */
  branch: string
  /** Sha of the `wip(operator)` commit. */
  commitSha: string
  /** Tracked paths swept into it. */
  files: readonly string[]
}

/**
 * Speak the auto-commit Notice.
 *
 * `post` is injectable so the copy can be exercised without a chat store;
 * production callers pass nothing.
 */
export const speakOperatorAutoCommitNotice = async (
  input: OperatorAutoCommitNoticeInput,
  post: typeof postConversationNotice = postConversationNotice,
): Promise<void> => {
  await post({
    kind: 'merge.operator-auto-commit',
    payload: {
      taskId: input.taskId,
      branch: input.branch,
      commitSha: input.commitSha,
      files: input.files,
    },
    // Urgent, not routine: this reports a commit made out of the operator's
    // own uncommitted work. Holding it until the next pause risks them
    // hunting for edits that are already committed under a name they have
    // never seen.
    priority: 'urgent',
  })
}

export interface BrokenAutoCommitAlertInput {
  /** Task whose merge the auto-commit unblocked. */
  taskId: string
  /** The integration branch the commit landed on. */
  branch: string
  /** Sha of the `wip(operator)` commit whose typecheck probe failed. */
  commitSha: string
  /** Combined typecheck output; only its head is surfaced. */
  output: string
}

/** How many lines of typecheck output the Alert carries. */
const PROBE_OUTPUT_LINES = 20

/**
 * Raise the "your auto-committed edit broke `main`" Alert (ADR-0100 slice 7).
 *
 * The companion to {@link speakOperatorAutoCommitNotice}: that one says a
 * commit was made, this one says the commit does not compile. It is raised
 * only when the post-auto-commit typecheck probe positively failed — never on
 * a probe timeout, which is no signal at all.
 *
 * Signed with the auto-commit sha so a re-probe of the SAME commit bumps the
 * existing open row rather than stacking a second one, while a later
 * auto-commit that is also broken gets its own Alert.
 *
 * `raise` is injectable so the copy can be exercised without a database;
 * production callers pass nothing.
 */
export const raiseBrokenAutoCommitAlert = async (
  input: BrokenAutoCommitAlertInput,
  raise: typeof raiseActionQueueItem = raiseActionQueueItem,
): Promise<void> => {
  const shortSha = input.commitSha.slice(0, 9)
  const outputHead = input.output
    .split('\n')
    .slice(0, PROBE_OUTPUT_LINES)
    .join('\n')
  const message =
    `The wip(operator) commit ${shortSha} that Mars auto-committed to unblock ` +
    `the merge of ${input.taskId} does not typecheck on ${input.branch}.`

  await raise({
    kind: 'health-check-alert',
    category: 'orchestrator',
    priority: 'high',
    title: `typecheck fails on ${input.branch} after auto-commit ${shortSha}`,
    body: [
      message,
      '',
      'Every task dispatched from here branches off a broken baseline, so fix it',
      `now: amend ${shortSha} (\`git commit --amend\`) or land a follow-up commit.`,
      '',
      'Typecheck output (first lines):',
      outputHead,
    ].join('\n'),
    payload: {
      conditionKey: 'operator-auto-commit-typecheck',
      message,
      checkDetails: {
        taskId: input.taskId,
        branch: input.branch,
        commitSha: input.commitSha,
        outputHead,
      },
    },
    context: { commitSha: input.commitSha, branch: input.branch },
    raisedBy: 'merge:operator-auto-commit-probe',
    signature: `operator-auto-commit-typecheck:${input.commitSha}`,
  })
}
