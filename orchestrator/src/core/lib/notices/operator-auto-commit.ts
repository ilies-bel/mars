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
      fileCount: input.files.length,
    },
    // Urgent, not routine: this reports a commit made out of the operator's
    // own uncommitted work. Holding it until the next pause risks them
    // hunting for edits that are already committed under a name they have
    // never seen.
    priority: 'urgent',
  })
}
