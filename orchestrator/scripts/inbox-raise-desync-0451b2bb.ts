/**
 * Self-heal escalation for task 0451b2bb.
 *
 * Context: this is the second self-heal pass for the same desync. The first
 * pass (commit c917426) re-confirmed that branch task/0451b2bb is a
 * "never-advanced branch" — its tip d3322b550388da6b7cd8e30959960c27262136d4
 * is itself an existing main commit ("feat(orchestrator): write per-scope
 * AGENTS.md from mars init") that predates the worktree. The branch ref
 * never advanced past its base, so:
 *   - git log main..task/0451b2bb       → empty (no work to land)
 *   - git log task/0451b2bb..main       → 8 commits at first refresh, 9+ now
 *   - git merge-base task/0451b2bb main → equals task/0451b2bb tip exactly
 *
 * The sweeper desync detector keeps flagging this as "merged=true,
 * mars=failed" because ancestor-of-main holds trivially, and dispatches a
 * fresh self-heal task each cycle (this run is mars-a20b03cb).
 *
 * The current self-heal task asks for one of two outcomes:
 *   (a) land branch into main, or
 *   (b) update the queue.db row's `error` column with rationale.
 *
 * Neither applies as written:
 *   (a) Wrong: there is nothing to land. main..task/0451b2bb is empty.
 *       A "rebase + ff" would be a no-op at best, or rewind main 9 commits
 *       at worst.
 *   (b) Not possible: row 0451b2bb was already purged from the live
 *       queue.db earlier this same day (a `queue.db.bak.selfheal-purge`
 *       backup file exists alongside it; the row is present there with
 *       status='failed' and the explanatory error column already set).
 *       UPDATEing a non-existent row would silently no-op.
 *
 * Per the self-heal task instructions, when neither (a) nor (b) is
 * decidable, this script raises an inbox item documenting the state so the
 * sweeper / a human can break the refire loop properly. The real fix is
 * tracked as task mars-b24ea96a ("sweeper: skip never-advanced branches");
 * that task is currently `failed` itself, which is why the loop persists.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-0451b2bb.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-a20b03cb'
const TARGET_TASK_ID = '0451b2bb'
const TARGET_BRANCH = 'task/0451b2bb'
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
      'init"). The branch ref never advanced past its base, so',
      '`git log main..task/0451b2bb` is empty.',
      '',
      'Path (a) — land branch into main: rejected. Nothing to land; rebase + ff',
      'is a no-op at best and a 9-commit rewind at worst.',
      '',
      'Path (b) — update tasks.error: rejected. Row 0451b2bb was already',
      'purged from the live queue.db earlier today (preserved in',
      '`.mars/queue.db.bak.selfheal-purge` with status=failed and the',
      'explanatory error column already set). UPDATE on the live row is a',
      'silent no-op.',
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
      mainAheadOfBranch: 'yes (≥9 commits)',
      branchAheadOfMain: 'no (empty)',
      followUpTaskId: FOLLOW_UP_TASK_ID,
      selfHealTaskId: SELF_HEAL_TASK_ID,
      priorSelfHealCommit: 'c917426',
    },
    context: {
      raisedFromTask: SELF_HEAL_TASK_ID,
      script: 'orchestrator/scripts/inbox-raise-desync-0451b2bb.ts',
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
