/**
 * Self-heal escalation for task 0a820a95.
 *
 * The desync detector flagged `task/0a820a95` as "merged=true, mars=failed":
 *   - queue.db (live): row 0a820a95 is ABSENT — already purged in an earlier
 *     self-heal sweep. The pre-purge backup at
 *     `.mars/queue.db.bak.selfheal-purge` still holds it with
 *       status      = 'failed'
 *       branch      = ''        (never set)
 *       error       = 'daemon restart while task was running'
 *       created_at  = 2026-05-09T07:47:12.199Z
 *       updated_at  = 2026-05-09T08:25:23.396Z
 *   - git: ref `task/0a820a95` exists, tip =
 *       d3322b550388da6b7cd8e30959960c27262136d4
 *     which is itself a pre-existing main commit
 *     ("feat(orchestrator): write per-scope AGENTS.md from mars init",
 *      committed 2026-05-09 00:50:52, hours BEFORE the task was even
 *      created). The branch ref never advanced past its base, so:
 *       git log main..task/0a820a95       → empty (no work to land)
 *       git log task/0a820a95..main       → many commits (main is far ahead)
 *       git merge-base task/0a820a95 main → equals task/0a820a95 tip
 *
 * The self-heal task asks for one of two outcomes:
 *   (a) land branch into main, or
 *   (b) update the queue.db row's `error` column with rationale.
 *
 * Neither applies as written:
 *   (a) Wrong: there is nothing to land. main..task/0a820a95 is empty.
 *       Rebase + ff is a no-op at best, and would risk rewinding main.
 *   (b) Not possible: row 0a820a95 was already purged from the live
 *       queue.db. UPDATE on the absent row is a silent no-op. The pre-purge
 *       backup already has status='failed' with the explanatory error.
 *
 * This is the same shape as prior never-advanced-branch escalations (see
 * inbox 9e4603ea for task 0451b2bb, c687ebca for 09b13b68, 0f6f0a5a for
 * 0847bf78). The underlying fix is tracked as task mars-b24ea96a
 * ("sweeper: skip never-advanced branches"), which is itself failed —
 * which is why the desync detector keeps re-firing self-heal for these.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-0a820a95.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-35111a1c'
const TARGET_TASK_ID = '0a820a95'
const TARGET_BRANCH = 'task/0a820a95'
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
      'past its base, so `git log main..task/0a820a95` is empty.',
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase + ff',
      'is a no-op at best and would risk rewinding main.',
      '',
      'Path (b) — update tasks.error: rejected. Row 0a820a95 was already',
      'purged from the live queue.db (preserved in',
      '`.mars/queue.db.bak.selfheal-purge` with status=failed and error',
      "'daemon restart while task was running'). UPDATE on the absent live",
      'row is a silent no-op.',
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
      mainAheadOfBranch: 'yes',
      branchAheadOfMain: 'no (empty)',
      followUpTaskId: FOLLOW_UP_TASK_ID,
      selfHealTaskId: SELF_HEAL_TASK_ID,
      preservedBackupError: 'daemon restart while task was running',
      preservedBackupCreatedAt: '2026-05-09T07:47:12.199Z',
      preservedBackupUpdatedAt: '2026-05-09T08:25:23.396Z',
    },
    context: {
      raisedFromTask: SELF_HEAL_TASK_ID,
      script: 'orchestrator/scripts/inbox-raise-desync-0a820a95.ts',
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
