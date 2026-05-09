/**
 * Self-heal escalation for task 0c76473f.
 *
 * The desync detector flagged `task/0c76473f` as "merged=true, mars=failed":
 *   - queue.db (live): row 0c76473f is ABSENT — already purged in an earlier
 *     self-heal sweep. The pre-purge backup at
 *     `.mars/queue.db.bak.selfheal-purge` still holds it with
 *       status      = 'failed'
 *       branch      = ''        (never set)
 *       error       = 'daemon restart while task was running'
 *       created_at  = 2026-05-09T07:44:55.100Z
 *       updated_at  = 2026-05-09T08:25:23.362Z
 *     Notably, 0c76473f was itself a self-heal task (its prompt targets
 *     task 05820b6f), spawned BEFORE the daemon restart that wedged it.
 *   - git: ref `task/0c76473f` exists, tip =
 *       d3322b550388da6b7cd8e30959960c27262136d4
 *     which is itself a pre-existing main commit
 *     ("feat(orchestrator): write per-scope AGENTS.md from mars init",
 *      committed 2026-05-09 00:47:52, hours BEFORE the task was even
 *      created). The branch ref never advanced past its base, so:
 *       git log main..task/0c76473f       → empty (no work to land)
 *       git log task/0c76473f..main       → 19 commits (main is far ahead)
 *       git merge-base task/0c76473f main → equals task/0c76473f tip
 *
 * The self-heal task asks for one of two outcomes:
 *   (a) land branch into main, or
 *   (b) update the queue.db row's `error` column with rationale.
 *
 * Neither applies as written:
 *   (a) Wrong: there is nothing to land. main..task/0c76473f is empty.
 *       Rebase + ff is a no-op at best, and would risk rewinding main.
 *   (b) Not possible: row 0c76473f was already purged from the live
 *       queue.db. UPDATE on the absent row is a silent no-op. The pre-purge
 *       backup already has status='failed' with the explanatory error.
 *
 * This is the same shape as prior never-advanced-branch escalations (see
 * inbox e5a5f481 for 0a820a95, 9e4603ea for 0451b2bb, c687ebca for
 * 09b13b68, 0f6f0a5a for 0847bf78). The underlying fix is tracked as task
 * mars-b24ea96a ("sweeper: skip never-advanced branches"), which is itself
 * failed — which is why the desync detector keeps re-firing self-heal for
 * these.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-0c76473f.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-dc8724e2'
const TARGET_TASK_ID = '0c76473f'
const TARGET_BRANCH = 'task/0c76473f'
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
      'past its base, so `git log main..task/0c76473f` is empty.',
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase + ff',
      'is a no-op at best and would risk rewinding main.',
      '',
      'Path (b) — update tasks.error: rejected. Row 0c76473f was already',
      'purged from the live queue.db (preserved in',
      '`.mars/queue.db.bak.selfheal-purge` with status=failed and error',
      "'daemon restart while task was running'). UPDATE on the absent live",
      'row is a silent no-op.',
      '',
      'Note: 0c76473f was itself a self-heal task (its prompt body targets',
      'task 05820b6f). The daemon restart wedged it before it could either',
      'advance its own branch or update the 05820b6f row, leaving a never-',
      'advanced ref behind.',
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
      currentStatus: 'failed (purged from live queue.db; preserved in .bak)',
      mainAheadOfBranch: 'yes (19 commits ahead)',
      branchAheadOfMain: 'no (empty)',
      followUpTaskId: FOLLOW_UP_TASK_ID,
      selfHealTaskId: SELF_HEAL_TASK_ID,
      preservedBackupError: 'daemon restart while task was running',
      preservedBackupCreatedAt: '2026-05-09T07:44:55.100Z',
      preservedBackupUpdatedAt: '2026-05-09T08:25:23.362Z',
      originalSelfHealTarget: '05820b6f',
    },
    context: {
      raisedFromTask: SELF_HEAL_TASK_ID,
      script: 'orchestrator/scripts/inbox-raise-desync-0c76473f.ts',
      raisedAt: '2026-05-09T15:55:34Z',
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync-never-advanced:${TARGET_TASK_ID}`,
  })
  // eslint-disable-next-line no-console
  console.log(`raised inbox item ${id}`)
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
