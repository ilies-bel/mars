/**
 * Self-heal escalation for task fd2e2ece.
 *
 * Originally fd2e2ece was itself a self-heal task (sweeper enqueued it at
 * 2026-05-09T07:56:29Z to heal task 94fe639d). It was killed by a daemon
 * restart mid-run; the pre-purge backup at
 * `.mars/queue.db.bak.selfheal-purge` records:
 *     status     = 'failed'
 *     branch     = ''            (never set)
 *     error      = 'daemon restart while task was running'
 *     updated_at = 2026-05-09T08:25:23.415Z
 *
 * The live `.mars/queue.db` no longer contains a row for fd2e2ece — it was
 * purged in a later self-heal sweep. Git, however, still holds:
 *   - `task/fd2e2ece` ref, tip = d3322b550388da6b7cd8e30959960c27262136d4
 *     ("feat(orchestrator): write per-scope AGENTS.md from mars init"), an
 *     existing main commit that predates the task by hours;
 *   - the worktree directory `.mars/worktrees/fd2e2ece/`.
 *
 *     git log main..task/fd2e2ece       → empty (no work to land)
 *     git log task/fd2e2ece..main       → 43 commits ahead
 *     git merge-base task/fd2e2ece main → equals branch tip
 *
 * This is the never-advanced-branch + purged-row pattern (precedent: inboxes
 * for tasks 0a820a95, 0451b2bb, 09b13b68, 0847bf78, fd588cd6, 0f203b55,
 * 0e287883). Neither prescribed self-heal path applies:
 *   (a) land branch into main: nothing to land; rebase + ff is a no-op at
 *       best and would risk rewinding main.
 *   (b) update tasks.error: row already absent from live queue.db; UPDATE
 *       is a silent no-op. The pre-purge backup already preserves the row
 *       with the explanatory error.
 *
 * The underlying sweeper fix HAS landed (commits b889c28 "fix(sweeper):
 * never-advanced branches are not 'merged'" and a1b5d0f "fix(sweeper):
 * treat zero-commit branches as stale, not desynced"); the latest sweeper
 * tick (2026-05-09T16:54:19Z) reports `desync-tasks=0` and fd2e2ece is no
 * longer flagged. What remains is operator cleanup of the orphan branch ref
 * and worktree directory.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-fd2e2ece.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-4bd39555'
const TARGET_TASK_ID = 'fd2e2ece'
const TARGET_BRANCH = 'task/fd2e2ece'
const BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const ORPHAN_WORKTREE = '.mars/worktrees/fd2e2ece'

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
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP}, which is itself a`,
      'pre-existing main commit ("feat(orchestrator): write per-scope',
      'AGENTS.md from mars init") that predates the task by hours. The',
      'branch ref never advanced past its base, so',
      `\`git log main..${TARGET_BRANCH}\` is empty (0 commits) while`,
      `\`git log ${TARGET_BRANCH}..main\` is 43 commits ahead.`,
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase + ff',
      'is a no-op at best and would risk rewinding main.',
      '',
      `Path (b) — update tasks.error: rejected. Row ${TARGET_TASK_ID} was`,
      'already purged from the live queue.db (preserved in',
      '`.mars/queue.db.bak.selfheal-purge` with status=failed and error',
      "'daemon restart while task was running'). UPDATE on the absent live",
      'row is a silent no-op.',
      '',
      'Sweeper-side fix has already landed (commits b889c28 and a1b5d0f);',
      'the latest sweeper tick reports desync-tasks=0 and fd2e2ece is no',
      'longer being flagged. What remains is operator cleanup of the',
      'orphan branch ref and worktree directory:',
      '',
      `  git worktree remove --force ${ORPHAN_WORKTREE}`,
      `  git branch -D ${TARGET_BRANCH}`,
      '',
      'The branch carries no unique work, so deletion is safe.',
    ].join('\n'),
    payload: {
      taskId: TARGET_TASK_ID,
      branch: TARGET_BRANCH,
      branchTip: BRANCH_TIP,
      orphanWorktree: ORPHAN_WORKTREE,
      currentStatus: 'failed (purged from live queue.db; preserved in .bak)',
      mainAheadOfBranch: '43 commits',
      branchAheadOfMain: '0 commits (empty)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      sweeperFixLanded: ['b889c28', 'a1b5d0f'],
      preservedBackupError: 'daemon restart while task was running',
      preservedBackupUpdatedAt: '2026-05-09T08:25:23.415Z',
      sweeperLatestTick: 'desync-tasks=0 (2026-05-09T16:54:19Z)',
    },
    context: {
      raisedFromTask: SELF_HEAL_TASK_ID,
      script: 'orchestrator/scripts/inbox-raise-desync-fd2e2ece.ts',
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync:${TARGET_TASK_ID}:never-advanced:purged-row`,
  })
  // eslint-disable-next-line no-console
  console.log(`raised inbox item ${id}`)
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
