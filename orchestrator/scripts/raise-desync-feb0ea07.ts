/**
 * Self-heal raise script for task feb0ea07.
 *
 * State at investigation time (2026-05-09):
 *   - task/feb0ea07 tip = d3322b550388da6b7cd8e30959960c27262136d4
 *   - That commit is on main (subject: "feat(orchestrator): write per-scope
 *     AGENTS.md from mars init"). `git log main..task/feb0ea07` is empty;
 *     `git rev-list --left-right --count main...task/feb0ea07` → "24  0".
 *   - queue.db has no row matching id='feb0ea07' (purged in a prior
 *     cleanup pass).
 *   - state.db has no inbox_items row referencing feb0ea07.
 *   - watch.log shows feb0ea07 was force-failed by reconcile-on-restart:
 *     `[2026-05-09T08:25:23.358Z] [reconcile] task feb0ea07 was running on
 *      prior daemon; marking failed`
 *     even though its branch had successfully landed in main.
 *   - sweeper.log shows the sweeper has been re-detecting this desync each
 *     tick since 13:07Z and enqueueing a new self-heal task for it on every
 *     pass (>15 self-heal tasks for this single desync).
 *
 * The two prescribed self-heal paths are not actionable:
 *   (a) Land branch into main → invalid; the branch is already on main.
 *   (b) Flip queue.db row to 'failed' with explanation → invalid; there is
 *       no row to flip.
 *
 * Action: raise a single inbox item documenting the desync so:
 *   - the human operator has a record of why feb0ea07 desynced (reconcile
 *     false-positive, not a real merge failure),
 *   - subsequent sweeper-triggered self-heal passes for this same task ID
 *     dedupe by fingerprint and just bump seen_count instead of writing
 *     fresh inbox rows.
 *
 * The kind `desync_landed_branch_marked_failed` matches the precedent set
 * by inbox 90b8ce47 (task 94fe639d), which has the same reconcile
 * false-positive shape.
 *
 * Re-running this script is a no-op once the inbox item exists — the
 * fingerprint (kind + signature) makes raiseInboxItem bump seen_count
 * instead of inserting a duplicate.
 *
 * Run from the orchestrator/ directory:
 *   npx tsx scripts/raise-desync-feb0ea07.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const TARGET_TASK_ID = 'feb0ea07'
const TARGET_BRANCH = 'task/feb0ea07'
const TARGET_BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const SELF_HEAL_WORKTREE = 'mars-b86fadd9'

const body = [
  `Task ${TARGET_TASK_ID} branch landed in main but its queue row has been`,
  `purged. Sweeper keeps detecting the lingering worktree+branch as a desync`,
  `and dispatching new self-heal tasks every tick.`,
  ``,
  `Investigation:`,
  `  - git rev-list --left-right --count main...${TARGET_BRANCH} → "24  0"`,
  `  - git merge-base main ${TARGET_BRANCH} → ${TARGET_BRANCH_TIP} (== branch tip)`,
  `  - branch tip subject: "feat(orchestrator): write per-scope AGENTS.md from`,
  `    mars init" — already in main.`,
  `  - sqlite3 .mars/queue.db "SELECT * FROM tasks WHERE id='${TARGET_TASK_ID}'"`,
  `    → no row.`,
  `  - sqlite3 .mars/state.db inbox_items LIKE '%${TARGET_TASK_ID}%' → no prior`,
  `    inbox item before this raise.`,
  `  - .mars/watch.log: "[2026-05-09T08:25:23.358Z] [reconcile] task`,
  `    ${TARGET_TASK_ID} was running on prior daemon; marking failed"`,
  `    — root cause: reconcile-on-restart force-failed the row even though`,
  `    the merge had already landed.`,
  ``,
  `Why neither prescribed path is actionable:`,
  `  (a) Land branch into main: empty diff. Already an ancestor of main.`,
  `  (b) Flip queue.db row to status='failed': no row to flip.`,
  ``,
  `Suggested operator actions:`,
  `  - Confirm by inspecting d3322b5 on main; close this inbox item with`,
  `    state=resolved, resolution=desync_landed_branch_marked_failed.`,
  `  - To stop the sweeper storm, remove the stale worktree+branch:`,
  `      git worktree remove .mars/worktrees/${TARGET_TASK_ID}`,
  `      git branch -D ${TARGET_BRANCH}`,
  `    The sweeper key is the worktree directory; once it's gone the desync`,
  `    detection stops firing for this task.`,
  ``,
  `Underlying bug to track separately: reconcile-on-restart should compare`,
  `the branch tip against main before flipping in-flight rows to 'failed' so`,
  `successfully-merged tasks don't get clobbered by a daemon restart.`,
].join('\n')

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync_landed_branch_marked_failed',
    category: 'daemon',
    priority: 'normal',
    title: `task ${TARGET_TASK_ID}: branch landed in main but row was purged after reconcile false-positive`,
    body,
    payload: {
      taskId: TARGET_TASK_ID,
      branch: TARGET_BRANCH,
      branchTip: TARGET_BRANCH_TIP,
      mainStatusAtRaise: 'failed-then-purged',
      mergedIntoMain: true,
      rootCause: 'reconcile-on-restart force-failed an already-merged task',
      selfHealWorktree: SELF_HEAL_WORKTREE,
    },
    context: {
      branch: TARGET_BRANCH,
      worktreePath: `.mars/worktrees/${TARGET_TASK_ID}`,
    },
    raisedBy: `self-heal:${SELF_HEAL_WORKTREE}`,
    signature: `desync:${TARGET_TASK_ID}:landed-but-row-purged`,
  })
  // eslint-disable-next-line no-console
  console.log(`raised inbox item ${id} for ${TARGET_BRANCH}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
