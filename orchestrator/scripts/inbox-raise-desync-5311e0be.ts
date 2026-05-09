/**
 * Self-heal escalation for task mars-5311e0be.
 *
 * mars-5311e0be is correctly recorded in the live queue as:
 *     status     = 'done'
 *     branch     = 'task/mars-5311e0be'
 *     error      = (none)
 *     updated_at = 2026-05-09T16:33:04.606Z
 *
 * The work content of this task DID land on main, but under a different commit
 * hash than the original task-branch tip:
 *
 *   task/mars-5311e0be tip = 1d1f8ef0a4b0faaf197a122e18f18976ef676eb1
 *     "feat(orchestrator): stamp every Mastra span with originId for
 *      arc-level timelines"
 *     base = 35b880d (merge-base task/mars-5311e0be main)
 *
 *   main contains 73921cca6872c039e461dcbf64c2e20814a87552
 *     "feat(orchestrator): stamp every Mastra span with originId for
 *      arc-level timelines"  (same author, same timestamp, same files)
 *
 *   rebase-5311e0be ref = 73921cc — the orchestrator's rebase branch
 *
 * The two commits are byte-equivalent except for one hunk in
 * orchestrator/src/mastra/workflows/implement-workflow.ts, where the
 * post-rebase version drops a `conversation` field and uses `usage` instead
 * — a conflict resolution against an interim refactor that landed on main
 * after the worktree was created. The rebase commit (73921cc) was
 * fast-forwarded into main; the original task/mars-5311e0be ref was never
 * updated to follow.
 *
 *     git log main..task/mars-5311e0be → 1 commit (1d1f8ef)
 *     git log task/mars-5311e0be..main → 18 commits
 *     git cherry main task/mars-5311e0be → "+ 1d1f8ef" (patch differs by
 *         the resolved hunk, so cherry treats it as unique even though the
 *         logical change is in main).
 *
 * This is NOT the never-advanced + purged-row pattern (precedent inboxes
 * for fc2e3721, fc483f12, fd2e2ece, fd588cd6, etc.). It is a different
 * shape: the task LANDED via a rebase branch, but the orchestrator did not
 * update the original task ref or record the rebased SHA anywhere queryable
 * by the sweeper. From the sweeper's point of view this looks like a
 * desync (task ref tip is not reachable from main); from the user's point
 * of view the work has shipped.
 *
 * Neither prescribed self-heal path applies:
 *   (a) land branch into main: rejected. The work is ALREADY on main as
 *       73921cc. Rebasing 1d1f8ef and fast-forwarding would produce a
 *       duplicate-content commit (or, more likely, an empty commit after
 *       the rebase squashes the resolved hunk). Worst case, it would
 *       reintroduce the pre-resolution `conversation` field and break the
 *       refactor that 73921cc absorbed.
 *   (b) update tasks.error to status='failed': rejected. The task SHIPPED.
 *       The work is on main and the user benefits from it. Marking it
 *       failed would lie in the queue and corrupt downstream metrics
 *       (success rate, retry signals, fix-for chains).
 *
 * The right cleanup is operator-side:
 *   - delete the orphan task branch (task/mars-5311e0be) since its work
 *     is content-equivalent to 73921cc on main;
 *   - delete the rebase ref (rebase-5311e0be), now redundant with main;
 *   - leave the queue row alone (status='done' is correct).
 *
 * Longer-term, the orchestrator should either record the rebased SHA on the
 * tasks row (e.g. a merged_sha column) or fast-forward the original task ref
 * to the rebased SHA after merge, so the sweeper can recognise this case
 * without operator intervention.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-raise-desync-5311e0be.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-f7a7483e'
const TARGET_TASK_ID = 'mars-5311e0be'
const TARGET_BRANCH = 'task/mars-5311e0be'
const BRANCH_TIP = '1d1f8ef0a4b0faaf197a122e18f18976ef676eb1'
const MERGE_BASE = '35b880d2968126c616e4f967486516945b63876b'
const REBASE_BRANCH = 'rebase-5311e0be'
const REBASED_SHA_ON_MAIN = '73921cca6872c039e461dcbf64c2e20814a87552'
const ORPHAN_WORKTREE = '.mars/worktrees/mars-5311e0be'

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync',
    category: 'orchestrator',
    priority: 'high',
    title: `Desync escalation: task ${TARGET_TASK_ID} landed via rebase under a different SHA`,
    body: [
      `Self-heal task ${SELF_HEAL_TASK_ID} cannot resolve the desync for`,
      `${TARGET_TASK_ID} via either of the two prescribed paths.`,
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP} (1 commit ahead of`,
      `merge-base ${MERGE_BASE}). Main is 18 commits ahead.`,
      '',
      'The logical work of this task IS on main: commit',
      `${REBASED_SHA_ON_MAIN} ("feat(orchestrator): stamp every Mastra`,
      'span with originId for arc-level timelines") has the same author,',
      'timestamp, message, and file list as the task-branch commit. The',
      'orchestrator created `rebase-5311e0be` (still pointing at',
      `${REBASED_SHA_ON_MAIN}) and fast-forwarded that into main, but the`,
      `original ${TARGET_BRANCH} ref was never updated to follow the rebase.`,
      '',
      'The two commits differ by exactly one hunk in',
      'orchestrator/src/mastra/workflows/implement-workflow.ts, where the',
      'post-rebase version drops a `conversation` field in favour of',
      '`usage` — a conflict resolution against an interim refactor on main.',
      '',
      'Path (a) — land branch into main: rejected. The work is already on',
      `main as ${REBASED_SHA_ON_MAIN}. Rebasing ${BRANCH_TIP} and`,
      'fast-forwarding would either produce a duplicate-content commit or',
      'reintroduce the pre-resolution `conversation` field, breaking the',
      'refactor that the rebased commit absorbed.',
      '',
      `Path (b) — update tasks.error to status='failed': rejected. The task`,
      "SHIPPED. status='done' is the correct record. Flipping it to 'failed'",
      'would lie in the queue and corrupt success-rate metrics, retry',
      'signals, and fix-for chains.',
      '',
      'The right cleanup is operator-side:',
      '',
      `  git worktree remove --force ${ORPHAN_WORKTREE}`,
      `  git branch -D ${TARGET_BRANCH}`,
      `  git branch -D ${REBASE_BRANCH}`,
      '',
      'Longer-term, the orchestrator should either record the rebased SHA on',
      'the tasks row (e.g. a merged_sha column) or fast-forward the original',
      'task ref to the rebased SHA after merge, so the sweeper can recognise',
      'this rebase-landed-but-ref-stale case without operator intervention.',
    ].join('\n'),
    payload: {
      taskId: TARGET_TASK_ID,
      branch: TARGET_BRANCH,
      branchTip: BRANCH_TIP,
      mergeBase: MERGE_BASE,
      rebaseBranch: REBASE_BRANCH,
      rebasedShaOnMain: REBASED_SHA_ON_MAIN,
      orphanWorktree: ORPHAN_WORKTREE,
      currentStatus: 'done',
      mainAheadOfBranch: '18 commits',
      branchAheadOfMain: '1 commit (1d1f8ef, content-equivalent to 73921cc on main modulo one resolved hunk)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      contentDifference:
        'orchestrator/src/mastra/workflows/implement-workflow.ts: rebased version replaces `conversation` field with `usage` (interim refactor on main).',
      cleanupCommands: [
        `git worktree remove --force ${ORPHAN_WORKTREE}`,
        `git branch -D ${TARGET_BRANCH}`,
        `git branch -D ${REBASE_BRANCH}`,
      ],
      followUp:
        'Add merged_sha column on tasks (or auto-update task ref post-merge) so the sweeper can detect rebase-landed-but-ref-stale tasks without manual triage.',
    },
    context: {
      script: 'orchestrator/scripts/inbox-raise-desync-5311e0be.ts',
      precedent: [
        'orchestrator/scripts/inbox-raise-desync-fc2e3721.ts',
        'orchestrator/scripts/inbox-raise-desync-fc483f12.ts',
        'orchestrator/scripts/inbox-raise-desync-fd2e2ece.ts',
        'orchestrator/scripts/inbox-raise-desync-fd588cd6.ts',
      ],
      shapeNote:
        'Distinct from the never-advanced + purged-row precedent: this task LANDED via a rebase branch but the original task ref was never updated.',
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync:${TARGET_TASK_ID}:rebase-landed-ref-stale`,
    occurrence: {
      at: new Date().toISOString(),
      selfHealTaskId: SELF_HEAL_TASK_ID,
      observation:
        'work content reachable on main as 73921cc via rebase-5311e0be; original task ref still at pre-rebase 1d1f8ef',
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
