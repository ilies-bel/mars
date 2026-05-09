/**
 * Self-heal escalation for task ff5710b2.
 *
 * The desync detector flagged `task/ff5710b2` as "merged=true, mars=failed":
 *   - queue.db (live): row ff5710b2 is ABSENT — already purged in an earlier
 *     self-heal sweep. The pre-purge backup at
 *     `.mars/queue.db.bak.selfheal-purge` still holds it with
 *       status      = 'failed'
 *       branch      = ''        (never set)
 *       error       = 'daemon restart while task was running'
 *       created_at  = 2026-05-09T07:41:51.897Z
 *       updated_at  = 2026-05-09T08:25:23.355Z
 *   - git: ref `task/ff5710b2` exists, tip =
 *       d3322b550388da6b7cd8e30959960c27262136d4
 *     which is itself a pre-existing main commit
 *     ("feat(orchestrator): write per-scope AGENTS.md from mars init",
 *      committed 2026-05-09 00:50:52, hours BEFORE the task was even
 *      created at 07:41:51). The branch ref never advanced past its base, so:
 *       git log main..task/ff5710b2       → empty (no work to land)
 *       git log task/ff5710b2..main       → many commits (main is far ahead)
 *       git merge-base task/ff5710b2 main → equals task/ff5710b2 tip
 *
 * The watch.log corroborates: `[implement] ff5710b2 dispatching` at 07:41:53,
 * then `[reconcile] task ff5710b2 was running on prior daemon; marking failed`
 * at 08:25:23. The agent never advanced the branch before the daemon died.
 *
 * The self-heal task asks for one of two outcomes:
 *   (a) land branch into main, or
 *   (b) update the queue.db row's `error` column with rationale.
 *
 * Neither applies as written:
 *   (a) Wrong: there is nothing to land. main..task/ff5710b2 is empty.
 *       Rebase + ff is a no-op at best, and would risk rewinding main.
 *   (b) Not possible: row ff5710b2 was already purged from the live
 *       queue.db. UPDATE on the absent row is a silent no-op. The pre-purge
 *       backup already has status='failed' with the explanatory error.
 *
 * This is the same shape as prior never-advanced-branch escalations (see
 * inbox e5a5f481 for task 0a820a95, d92e69ca for ff8c6206, 9e4603ea for
 * 0451b2bb). The underlying fix is tracked as task mars-b24ea96a
 * ("sweeper: skip never-advanced branches"), which is itself failed —
 * which is why the desync detector keeps re-firing self-heal for these.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-ff5710b2.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-0c1eced5'
const TARGET_TASK_ID = 'ff5710b2'
const TARGET_BRANCH = 'task/ff5710b2'
const BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const FOLLOW_UP_TASK_ID = 'mars-b24ea96a'

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
      'past its base, so `git log main..task/ff5710b2` is empty.',
      '',
      'watch.log shows the task was dispatched at 07:41:53 then reconciled to',
      "'failed' at 08:25:23 with reason 'daemon restart while task was",
      "running' — i.e. the agent never got to commit anything before the",
      'prior daemon died.',
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase + ff',
      'is a no-op at best and would risk rewinding main.',
      '',
      'Path (b) — update tasks.error: rejected. Row ff5710b2 was already',
      'purged from the live queue.db (preserved in',
      '`.mars/queue.db.bak.selfheal-purge` with status=failed and error',
      "'daemon restart while task was running'). UPDATE on the absent live",
      'row is a silent no-op.',
      '',
      `Underlying fix is tracked as ${FOLLOW_UP_TASK_ID} (sweeper: skip`,
      'never-advanced branches), which is itself currently failed — that is',
      'why the desync detector keeps refiring this self-heal. The latest',
      'sweeper tick (15:29) enqueued 617 desync self-heal tasks in one pass,',
      'so the loop is now systemic, not specific to ff5710b2.',
      '',
      'Action requested: either revive / fix mars-b24ea96a so the sweeper',
      'stops dispatching self-heal tasks for never-advanced branches, or',
      `manually delete branch ${TARGET_BRANCH} (it has no unique work).`,
    ].join('\n'),
    payload: {
      taskId: TARGET_TASK_ID,
      branch: TARGET_BRANCH,
      branchTip: BRANCH_TIP,
      currentStatus: 'failed (purged from live queue.db; preserved in .bak)',
      mainAheadOfBranch: 'yes',
      branchAheadOfMain: 'no (empty)',
      followUpTaskId: FOLLOW_UP_TASK_ID,
      selfHealTaskId: SELF_HEAL_TASK_ID,
      preservedBackupError: 'daemon restart while task was running',
      preservedBackupCreatedAt: '2026-05-09T07:41:51.897Z',
      preservedBackupUpdatedAt: '2026-05-09T08:25:23.355Z',
      sweeperLoopOccurrences: 16,
    },
    context: {
      raisedFromTask: SELF_HEAL_TASK_ID,
      script: 'orchestrator/scripts/inbox-raise-desync-ff5710b2.ts',
    },
    raisedBy: `task:${SELF_HEAL_TASK_ID}`,
    signature: `desync:${TARGET_TASK_ID}:never-advanced:purged-row`,
  })
  // eslint-disable-next-line no-console
  console.log(id)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
