/**
 * Self-heal escalation for task fd588cd6.
 *
 * The desync detector flagged `task/fd588cd6` as "merged=true, mars=failed":
 *   - queue.db (live): row fd588cd6 is ABSENT — already purged in an earlier
 *     self-heal sweep. The pre-purge backup at
 *     `.mars/queue.db.bak.selfheal-purge` still holds it with
 *       status      = 'failed'
 *       branch      = 'task/fd588cd6'
 *       error       = 'daemon restart while task was running'
 *       created_at  = 2026-05-09T07:17:14.710Z
 *       updated_at  = 2026-05-09T08:25:23.337Z
 *   - git: ref `task/fd588cd6` exists, tip =
 *       d3322b550388da6b7cd8e30959960c27262136d4
 *     which is itself a pre-existing main commit
 *     ("feat(orchestrator): write per-scope AGENTS.md from mars init",
 *     committed 2026-05-09 00:47:52 +0200, hours BEFORE the task was even
 *     created at 07:17:14 UTC). The branch ref never advanced past its base:
 *       git log main..task/fd588cd6       → empty (no work to land)
 *       git log task/fd588cd6..main       → main is ahead (~7 commits)
 *       git rev-list --count main..task/fd588cd6 → 0
 *       git reflog show task/fd588cd6     → "Created from main" only
 *
 * watch.log corroborates: `[implement] fd588cd6 dispatching` at
 * 2026-05-09T07:17:15.405Z, then
 * `[reconcile] task fd588cd6 was running on prior daemon; marking failed`
 * at 2026-05-09T08:25:23.337Z. The agent never advanced the branch before
 * the daemon died.
 *
 * Bonus context: fd588cd6 was itself a self-heal task created by the
 * sweeper to heal task/f38ee71b (a real task that produced no diff and was
 * correctly dropped by the verify step's empty-diff gate). The sweeper's
 * desync check (git merge-base --is-ancestor) returns true for any branch
 * pointing at main, so it misclassified that no-op terminal task as
 * landed-but-mismarked and enqueued fd588cd6 to "land" it. fd588cd6 itself
 * then died to the daemon-restart reconcile and now suffers the same
 * misclassification — a second-order victim of the same root cause. The
 * sweeper.log shows 15+ subsequent self-heal dispatches for fd588cd6
 * already.
 *
 * The self-heal task asks for one of two outcomes:
 *   (a) land branch into main, or
 *   (b) update the queue.db row's `error` column with rationale.
 *
 * Neither applies as written:
 *   (a) Wrong: there is nothing to land. main..task/fd588cd6 is empty.
 *       Rebase + ff is a no-op at best, and would risk rewinding main.
 *   (b) Not possible: row fd588cd6 was already purged from the live
 *       queue.db. UPDATE on the absent row is a silent no-op. The pre-purge
 *       backup already has status='failed' with the explanatory error.
 *       Re-inserting the row would just retrigger the desync detector on
 *       the next sweeper tick.
 *
 * This is the same shape as prior never-advanced-branch escalations (see
 * inbox 6547339c for 0e287883, d11923a2 for ff5710b2, e5a5f481 for
 * 0a820a95, ccb32d6b for ff08b9a9, 90515a6b for feb0ea07, etc.). The
 * underlying fix is tracked as task mars-b24ea96a ("sweeper: skip
 * never-advanced branches"), which is queued in the .bak but absent from
 * the live queue.db — which is why the desync detector keeps re-firing
 * self-heal for these.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-fd588cd6.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-4c9ad098'
const TARGET_TASK_ID = 'fd588cd6'
const TARGET_BRANCH = 'task/fd588cd6'
const BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const FOLLOW_UP_TASK_ID = 'mars-b24ea96a'
const PARENT_DESYNC_TASK_ID = 'f38ee71b'

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync',
    category: 'orchestrator',
    priority: 'high',
    title: `Desync escalation: task ${TARGET_TASK_ID} cannot be auto-healed (never-advanced branch + purged row)`,
    body: [
      `Self-heal task ${SELF_HEAL_TASK_ID} cannot resolve the desync for`,
      `${TARGET_TASK_ID} via either of the two prescribed paths.`,
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP}, which is itself an existing`,
      'main commit ("feat(orchestrator): write per-scope AGENTS.md from mars',
      'init") that predates the task by hours. The branch ref never advanced',
      'past its base:',
      '  git log main..task/fd588cd6       → empty',
      '  git rev-list --count main..task/fd588cd6 → 0',
      '  git reflog show task/fd588cd6     → "Created from main" only',
      '',
      'watch.log shows the task was dispatched at 2026-05-09T07:17:15.405Z',
      "then reconciled to 'failed' at 2026-05-09T08:25:23.337Z with reason",
      "'daemon restart while task was running' — i.e. the agent never got",
      'to commit anything before the prior daemon died.',
      '',
      `Note: ${TARGET_TASK_ID} was itself a self-heal task created by the`,
      `sweeper to heal task/${PARENT_DESYNC_TASK_ID}, a real task that`,
      'produced no diff and was correctly dropped by the verify-step',
      'empty-diff gate. The sweeper misclassified that no-op terminal as',
      'landed-but-mismarked and enqueued fd588cd6 to "land" it. fd588cd6',
      'is therefore a second-order victim of the same sweeper bug.',
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase + ff',
      'is a no-op at best and would risk rewinding main.',
      '',
      'Path (b) — update tasks.error: rejected. Row fd588cd6 was already',
      'purged from the live queue.db (preserved in',
      '`.mars/queue.db.bak.selfheal-purge` with status=failed and error',
      "'daemon restart while task was running'). UPDATE on the absent live",
      'row is a silent no-op. Re-INSERTing the row would just retrigger the',
      'desync detector on the next sweeper tick.',
      '',
      `Underlying fix is tracked as ${FOLLOW_UP_TASK_ID} (sweeper: skip`,
      'never-advanced branches), which is queued in the .bak backup but',
      'absent from the live queue.db. That is why the desync detector keeps',
      'refiring this self-heal — sweeper.log already records 15+ separate',
      'self-heal dispatches for this single task.',
      '',
      `Action requested: either revive / fix ${FOLLOW_UP_TASK_ID} so the`,
      'sweeper stops dispatching self-heal tasks for never-advanced',
      `branches, or manually delete branch ${TARGET_BRANCH} (it has no`,
      'unique work).',
    ].join('\n'),
    payload: {
      taskId: TARGET_TASK_ID,
      branch: TARGET_BRANCH,
      branchTip: BRANCH_TIP,
      currentStatus: 'failed (purged from live queue.db; preserved in .bak)',
      followUpTaskId: FOLLOW_UP_TASK_ID,
      parentDesyncTaskId: PARENT_DESYNC_TASK_ID,
      selfHealTaskId: SELF_HEAL_TASK_ID,
      shape: 'never-advanced-branch + purged-row',
    },
    context: {
      worktreePath: `.mars/worktrees/${TARGET_TASK_ID}`,
      branch: TARGET_BRANCH,
      taskId: TARGET_TASK_ID,
    },
    raisedBy: `self-heal:${SELF_HEAL_TASK_ID}`,
    signature: `desync:${TARGET_TASK_ID}:${BRANCH_TIP}`,
  })
  console.log(`raised inbox item ${id} for ${TARGET_TASK_ID}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
