/**
 * Self-heal escalation for task 0b454825.
 *
 * The desync detector flagged `task/0b454825` as "merged=true, mars=failed":
 *   - queue.db (live): row 0b454825 PRESENT with
 *       status     = 'failed'
 *       branch     = 'task/0b454825'
 *       error      = 'daemon restart while task was running'
 *       created_at = 2026-05-09T05:01:14.316Z
 *       updated_at = 2026-05-09T12:46:53.676Z
 *   - watch.log:
 *       2026-05-09T08:25:23.119Z [implement] 0b454825 dispatching
 *       2026-05-09T12:46:53.676Z [reconcile] task 0b454825 was running on
 *         prior daemon; marking failed
 *     i.e. the daemon crashed mid-run, before any commit on the worktree.
 *   - git: ref `task/0b454825` exists, tip =
 *       d3322b550388da6b7cd8e30959960c27262136d4
 *     which is itself a pre-existing main commit
 *     ("feat(orchestrator): write per-scope AGENTS.md from mars init"),
 *     committed 2026-05-09T00:50:52 — hours BEFORE the task was even
 *     created. The branch ref never advanced past its base, so:
 *       git log main..task/0b454825       → empty (no work to land)
 *       git log task/0b454825..main       → many commits (main far ahead)
 *       git merge-base task/0b454825 main → equals task/0b454825 tip
 *
 * The self-heal task asks for one of two outcomes:
 *   (a) land branch into main, or
 *   (b) update the queue.db row's `error` column with rationale.
 *
 * Path (a) is invalid: there is nothing to land. main..task/0b454825 is
 * empty. Rebase + ff is a no-op at best, and would risk rewinding main.
 *
 * Path (b) is technically already satisfied: the row is already
 * status='failed' with the canonical reconcile error message. Rather than
 * overwrite that historically-truthful error, we leave it intact and raise
 * an inbox item describing the structural desync — same shape as prior
 * never-advanced-branch escalations:
 *   - 0a820a95  → inbox e5a5f481 (purged-row variant)
 *   - 0451b2bb  → inbox 9e4603ea
 *   - ff8c6206  → inbox d92e69ca
 *
 * The underlying fix is tracked as task mars-b24ea96a
 * ("sweeper: skip never-advanced branches"), which is itself failed —
 * which is why the desync detector keeps re-firing self-heal for these.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-0b454825.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const TARGET_TASK_ID = '0b454825'
const TARGET_BRANCH = 'task/0b454825'
const BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const FOLLOW_UP_TASK_ID = 'mars-b24ea96a'
const SELF_HEAL_WORKTREE = 'mars-25755ce7'

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync',
    category: 'orchestrator',
    priority: 'high',
    title: `Desync escalation: task ${TARGET_TASK_ID} cannot be auto-healed (never-advanced branch, row already failed)`,
    body: [
      `Self-heal dispatched in worktree ${SELF_HEAL_WORKTREE} cannot resolve`,
      `the desync for ${TARGET_TASK_ID} via either of the two prescribed`,
      'paths.',
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP}, which is itself an`,
      'existing main commit ("feat(orchestrator): write per-scope AGENTS.md',
      'from mars init") that predates the task by hours. The branch ref',
      'never advanced past its base, so `git log main..task/0b454825` is',
      'empty.',
      '',
      'watch.log confirms the chain of events:',
      '  2026-05-09T08:25:23.119Z [implement] 0b454825 dispatching',
      '  2026-05-09T12:46:53.676Z [reconcile] task 0b454825 was running on',
      '    prior daemon; marking failed',
      'The daemon crashed mid-run; the worktree never produced a commit, so',
      'the branch ref stayed at the base it was forked from.',
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase',
      '+ ff is a no-op at best and would risk rewinding main.',
      '',
      'Path (b) — update tasks.error: rejected as redundant. The live row',
      "already has status='failed' with the historically-truthful error",
      "'daemon restart while task was running'. Overwriting that with a",
      'desync-rationale string would lose the original failure cause for no',
      'gain — the desync is structural (sweeper false-positive), not a row',
      'data problem.',
      '',
      `Underlying fix is tracked as ${FOLLOW_UP_TASK_ID} (sweeper: skip`,
      'never-advanced branches), which is itself currently failed — that is',
      'why the desync detector keeps refiring this self-heal.',
      '',
      'Action requested: either revive / fix mars-b24ea96a so the sweeper',
      'stops dispatching self-heal tasks for never-advanced branches, or',
      `manually delete branch ${TARGET_BRANCH} (it has no unique work).`,
    ].join('\n'),
    payload: {
      taskId: TARGET_TASK_ID,
      branch: TARGET_BRANCH,
      branchTip: BRANCH_TIP,
      currentStatus: 'failed (live queue.db row, not purged)',
      currentError: 'daemon restart while task was running',
      mainAheadOfBranch: 'yes',
      branchAheadOfMain: 'no (empty)',
      followUpTaskId: FOLLOW_UP_TASK_ID,
      selfHealWorktree: SELF_HEAL_WORKTREE,
      taskCreatedAt: '2026-05-09T05:01:14.316Z',
      taskUpdatedAt: '2026-05-09T12:46:53.676Z',
      dispatchedAt: '2026-05-09T08:25:23.119Z',
      reconciledAt: '2026-05-09T12:46:53.676Z',
    },
    context: {
      raisedFromWorktree: SELF_HEAL_WORKTREE,
      script: 'orchestrator/scripts/inbox-raise-desync-0b454825.ts',
    },
    raisedBy: `worktree:${SELF_HEAL_WORKTREE}`,
    signature: `desync:${TARGET_TASK_ID}:never-advanced:row-already-failed`,
  })
  // eslint-disable-next-line no-console
  console.log(`raised inbox item ${id}`)
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
