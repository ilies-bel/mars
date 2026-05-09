/**
 * Self-heal escalation for task 0e287883.
 *
 * The desync detector flagged `task/0e287883` as "merged=true, mars=failed":
 *   - queue.db (live): row 0e287883 is ABSENT — already purged in an earlier
 *     self-heal sweep. The pre-purge backup at
 *     `.mars/queue.db.bak.selfheal-purge` still holds it with
 *       status      = 'failed'
 *       branch      = '' (empty)
 *       error       = 'daemon restart while task was running'
 *       created_at  = 2026-05-09T07:52:12.830Z
 *       updated_at  = 2026-05-09T08:25:23.408Z
 *   - git: ref `task/0e287883` exists, tip =
 *       d3322b550388da6b7cd8e30959960c27262136d4
 *     which is itself a pre-existing main commit
 *     ("feat(orchestrator): write per-scope AGENTS.md from mars init",
 *      committed 2026-05-09 00:47:52 +0200, hours BEFORE the task was even
 *      created at 07:52:12 UTC). The branch ref never advanced past its base,
 *      so:
 *       git log main..task/0e287883       → empty (no work to land)
 *       git log task/0e287883..main       → 24 commits (main is far ahead)
 *       git merge-base task/0e287883 main → equals task/0e287883 tip
 *
 * The watch.log corroborates: `[implement] 0e287883 dispatching` at 07:52:13,
 * then `[reconcile] task 0e287883 was running on prior daemon; marking failed`
 * at 08:25:23. The agent never advanced the branch before the daemon died.
 *
 * Bonus context: 0e287883 was itself a self-heal task created by the sweeper
 * to heal task/50ed4fa2 (see sweeper.log line 1526). It is a second-order
 * victim of the same daemon-restart event.
 *
 * The self-heal task asks for one of two outcomes:
 *   (a) land branch into main, or
 *   (b) update the queue.db row's `error` column with rationale.
 *
 * Neither applies as written:
 *   (a) Wrong: there is nothing to land. main..task/0e287883 is empty.
 *       Rebase + ff is a no-op at best, and would risk rewinding main.
 *   (b) Not possible: row 0e287883 was already purged from the live
 *       queue.db. UPDATE on the absent row is a silent no-op. The pre-purge
 *       backup already has status='failed' with the explanatory error.
 *       Re-inserting the row would just retrigger the desync detector on the
 *       next sweeper tick.
 *
 * This is the same shape as prior never-advanced-branch escalations (see
 * inbox d11923a2 for ff5710b2, e5a5f481 for 0a820a95, d92e69ca for ff8c6206,
 * 9e4603ea for 0451b2bb, ccb32d6b for ff08b9a9). The underlying fix is tracked
 * as task mars-b24ea96a ("sweeper: skip never-advanced branches"), which is
 * itself failed (DuckDB lock contention) — which is why the desync detector
 * keeps re-firing self-heal for these.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-0e287883.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-b44de1de'
const TARGET_TASK_ID = '0e287883'
const TARGET_BRANCH = 'task/0e287883'
const BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const FOLLOW_UP_TASK_ID = 'mars-b24ea96a'
const PARENT_DESYNC_TASK_ID = '50ed4fa2'

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
      'past its base, so `git log main..task/0e287883` is empty (24 behind, 0',
      'ahead).',
      '',
      'watch.log shows the task was dispatched at 07:52:13 then reconciled to',
      "'failed' at 08:25:23 with reason 'daemon restart while task was",
      "running' — i.e. the agent never got to commit anything before the",
      'prior daemon died.',
      '',
      `Note: ${TARGET_TASK_ID} was itself a self-heal task created by the`,
      `sweeper to heal task/${PARENT_DESYNC_TASK_ID}. It is a second-order`,
      'victim of the same daemon-restart event.',
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase + ff',
      'is a no-op at best and would risk rewinding main.',
      '',
      'Path (b) — update tasks.error: rejected. Row 0e287883 was already',
      'purged from the live queue.db (preserved in',
      '`.mars/queue.db.bak.selfheal-purge` with status=failed and error',
      "'daemon restart while task was running'). UPDATE on the absent live",
      'row is a silent no-op. Re-INSERTing the row would just retrigger the',
      'desync detector on the next sweeper tick.',
      '',
      `Underlying fix is tracked as ${FOLLOW_UP_TASK_ID} (sweeper: skip`,
      'never-advanced branches), which is itself currently failed — that is',
      'why the desync detector keeps refiring this self-heal. The sweeper log',
      'shows 16 separate self-heal dispatches for this single task already.',
      '',
      `Action requested: either revive / fix ${FOLLOW_UP_TASK_ID} so the`,
      'sweeper stops dispatching self-heal tasks for never-advanced branches,',
      `or manually delete branch ${TARGET_BRANCH} (it has no unique work).`,
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
