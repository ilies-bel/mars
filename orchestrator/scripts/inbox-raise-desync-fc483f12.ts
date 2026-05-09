/**
 * Self-heal escalation for task fc483f12.
 *
 * fc483f12 was itself a self-heal task (sweeper enqueued it at
 * 2026-05-09T07:56:44.328Z to heal task 6b189ba2). It was killed by a daemon
 * restart mid-run; the pre-purge backup at
 * `.mars/queue.db.bak.selfheal-purge` records:
 *     status     = 'failed'
 *     branch     = ''            (never set)
 *     error      = 'daemon restart while task was running'
 *     updated_at = 2026-05-09T08:25:23.416Z
 *
 * The live `.mars/queue.db` no longer contains a row for fc483f12 — it was
 * purged in a later self-heal sweep. Git, however, still holds:
 *   - `task/fc483f12` ref, tip = d3322b550388da6b7cd8e30959960c27262136d4
 *     ("feat(orchestrator): write per-scope AGENTS.md from mars init"), an
 *     existing main commit that predates the task by hours;
 *   - the locked worktree `.mars/worktrees/fc483f12` (detached HEAD).
 *
 *     git log main..task/fc483f12       → empty (no work to land)
 *     git log task/fc483f12..main       → 44 commits ahead
 *     git merge-base task/fc483f12 main → equals branch tip
 *
 * This is the never-advanced-branch + purged-row pattern (precedent: inboxes
 * for tasks fd2e2ece, 0a820a95, 0451b2bb, fd588cd6, 0f203b55, 0e287883, ...).
 * Neither prescribed self-heal path applies:
 *   (a) land branch into main: nothing to land; rebase + ff is a no-op at
 *       best and would risk rewinding main.
 *   (b) update tasks.error: row already absent from live queue.db; UPDATE
 *       is a silent no-op. The pre-purge backup already preserves the row
 *       with the explanatory error.
 *
 * The underlying sweeper fix HAS landed (commits b889c28 "fix(sweeper):
 * never-advanced branches are not 'merged'" and a1b5d0f "fix(sweeper):
 * treat zero-commit branches as stale, not desynced"); the latest sweeper
 * tick (2026-05-09T16:54:19Z) reports `desync-tasks=0` and fc483f12 is no
 * longer flagged. What remains is operator cleanup of the orphan branch ref
 * and worktree directory.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-fc483f12.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-cfd2474b'
const TARGET_TASK_ID = 'fc483f12'
const TARGET_BRANCH = 'task/fc483f12'
const BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const ORPHAN_WORKTREE = '.mars/worktrees/fc483f12'

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
      `\`git log ${TARGET_BRANCH}..main\` is 44 commits ahead.`,
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
      `(Note: ${TARGET_TASK_ID} was itself a self-heal task originally`,
      'enqueued to heal task 6b189ba2; it never advanced before the daemon',
      'restart killed it. So the visible "desync" is doubly vacuous —',
      'a self-heal task that died before doing any work.)',
      '',
      'Sweeper-side fix has already landed (commits b889c28 and a1b5d0f);',
      'the latest sweeper tick reports desync-tasks=0 and fc483f12 is no',
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
      mainAheadOfBranch: '44 commits',
      branchAheadOfMain: '0 commits (empty)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      sweeperFixLanded: ['b889c28', 'a1b5d0f'],
      preservedBackupError: 'daemon restart while task was running',
      preservedBackupUpdatedAt: '2026-05-09T08:25:23.416Z',
      preservedBackupCreatedAt: '2026-05-09T07:56:44.328Z',
      originallySelfHealingTaskId: '6b189ba2',
      cleanupCommands: [
        `git worktree remove --force ${ORPHAN_WORKTREE}`,
        `git branch -D ${TARGET_BRANCH}`,
      ],
    },
    context: {
      script: 'orchestrator/scripts/inbox-raise-desync-fc483f12.ts',
      precedent: [
        'orchestrator/scripts/inbox-raise-desync-fd2e2ece.ts',
        'orchestrator/scripts/inbox-raise-desync-fd588cd6.ts',
        'orchestrator/scripts/inbox-raise-desync-0a820a95.ts',
        'orchestrator/scripts/inbox-raise-desync-0451b2bb.ts',
      ],
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync:${TARGET_TASK_ID}:never-advanced+purged`,
    occurrence: {
      at: new Date().toISOString(),
      selfHealTaskId: SELF_HEAL_TASK_ID,
      observation: 'never-advanced branch, row purged from live queue.db',
    },
  })

  // eslint-disable-next-line no-console
  console.log(`raised inbox item ${id} for desync ${TARGET_TASK_ID}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
