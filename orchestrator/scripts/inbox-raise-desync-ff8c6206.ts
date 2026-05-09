/**
 * Self-heal escalation for task ff8c6206.
 *
 * Same shape as the 0451b2bb / 338eb620 / 054dc6d5 escalations: the branch
 * task/ff8c6206 is a "never-advanced" branch. Its tip
 * d3322b550388da6b7cd8e30959960c27262136d4 is itself an existing main commit
 * ("feat(orchestrator): write per-scope AGENTS.md from mars init") that
 * predates the worktree. The branch ref never advanced past its base, so:
 *   - git log main..task/ff8c6206       → empty (no work to land)
 *   - git log task/ff8c6206..main       → many commits (main moved on)
 *   - git merge-base task/ff8c6206 main → equals task/ff8c6206 tip exactly
 *
 * Origin: ff8c6206 was itself a self-heal task enqueued by the sweeper at
 * 2026-05-09T07:45:37 to fix a desync on task/05820b6f. It never produced any
 * commits — the queue.db backup `.mars/queue.db.bak.selfheal-purge` shows the
 * row with status='failed', error='daemon restart while task was running',
 * created_at 07:45:35, updated_at 08:25:23. The task transcript table has
 * zero rows for ff8c6206, confirming the code step never ran.
 *
 * The sweeper desync detector keeps flagging this as "merged=true,
 * mars=failed" because ancestor-of-main holds trivially, and dispatched a
 * fresh self-heal task each cycle (this run is mars-15c94b6c). Between the
 * 13:07:32 first dispatch and the 15:28:55 last dispatch, the sweeper
 * enqueued 16 self-heal tasks for ff8c6206 alone.
 *
 * Both prescribed self-heal outcomes fail to apply:
 *   (a) land branch into main: nothing to land, main..task/ff8c6206 is empty.
 *       A "rebase + ff" would be a no-op at best, or rewind main at worst.
 *   (b) update the queue.db row's `error` column: row ff8c6206 was already
 *       purged from the live queue.db earlier today (preserved in
 *       `.mars/queue.db.bak.selfheal-purge` with status='failed' and the
 *       original error 'daemon restart while task was running'). UPDATEing a
 *       non-existent row would silently no-op.
 *
 * Per the self-heal task instructions, when neither (a) nor (b) is decidable
 * this script raises an inbox item documenting the state so the sweeper / a
 * human can break the refire loop properly. The real fix is tracked as task
 * mars-b24ea96a ("Sweeper desync detector: skip never-advanced branches
 * whose tip is an existing main commit") and mars-2addd4c0 ("Sweeper desync
 * detector treats unadvanced task branches as 'merged=true' and creates
 * runaway self-heal loops"); both are currently `failed` themselves, which
 * is why the loop persists.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-ff8c6206.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-15c94b6c'
const TARGET_TASK_ID = 'ff8c6206'
const TARGET_BRANCH = 'task/ff8c6206'
const BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const FOLLOW_UP_TASK_IDS = ['mars-b24ea96a', 'mars-2addd4c0']

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
      'init"). The branch ref never advanced past its base, so',
      '`git log main..task/ff8c6206` is empty.',
      '',
      `Origin: ${TARGET_TASK_ID} was itself a self-heal task enqueued by the`,
      'sweeper at 2026-05-09T07:45:37 to fix a desync on task/05820b6f. It',
      'never produced any commits. The backup queue.db row',
      "(.mars/queue.db.bak.selfheal-purge) records status='failed', error=",
      "'daemon restart while task was running'. The task_transcripts table",
      'has zero rows for ff8c6206, confirming the code step never ran.',
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase + ff',
      'is a no-op at best and a multi-commit rewind at worst.',
      '',
      'Path (b) — update tasks.error: rejected. Row ff8c6206 was already',
      'purged from the live queue.db earlier today (preserved in',
      '`.mars/queue.db.bak.selfheal-purge` with status=failed and the original',
      "error column already set to 'daemon restart while task was running').",
      'UPDATE on the live row is a silent no-op.',
      '',
      `Underlying fix is tracked as ${FOLLOW_UP_TASK_IDS.join(' and ')}`,
      '(sweeper: skip never-advanced branches), both currently failed — that',
      'is why the desync detector keeps refiring this self-heal.',
      '',
      'Action requested: either revive / fix the sweeper follow-up tasks so',
      'the sweeper stops dispatching self-heal tasks for never-advanced',
      `branches, or manually delete branch ${TARGET_BRANCH} (it has no unique`,
      'work) and remove the empty worktree directory.',
    ].join('\n'),
    payload: {
      taskId: TARGET_TASK_ID,
      branch: TARGET_BRANCH,
      branchTip: BRANCH_TIP,
      currentStatus: 'failed (purged from live queue.db; preserved in .bak)',
      originalError: 'daemon restart while task was running',
      mainAheadOfBranch: 'yes (many commits)',
      branchAheadOfMain: 'no (empty)',
      transcriptCount: 0,
      sweeperRefireCount: 16,
      followUpTaskIds: FOLLOW_UP_TASK_IDS,
      selfHealTaskId: SELF_HEAL_TASK_ID,
    },
    context: {
      raisedFromTask: SELF_HEAL_TASK_ID,
      script: 'orchestrator/scripts/inbox-raise-desync-ff8c6206.ts',
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
