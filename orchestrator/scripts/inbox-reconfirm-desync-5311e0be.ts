/**
 * Self-heal re-confirmation for task mars-5311e0be.
 *
 * The desync between mars (status='done' on mars-5311e0be) and git
 * (task/mars-5311e0be tip not reachable from main) is the same
 * "rebase-landed-ref-stale" shape already escalated by the prior
 * self-heal task mars-f7a7483e (inbox item ecdd51fb, still open).
 *
 * Confirmed during this self-heal pass (task mars-f794be38):
 *   - task/mars-5311e0be tip = 1d1f8ef0a4b0faaf197a122e18f18976ef676eb1
 *   - main contains 73921cca6872c039e461dcbf64c2e20814a87552, byte-equivalent
 *     to the task-branch commit modulo one resolved hunk in
 *     orchestrator/src/mastra/workflows/implement-workflow.ts
 *     (post-rebase replaces `conversation` with `usage`).
 *   - rebase-5311e0be ref still pointing at 73921cc (the rebase landed via
 *     fast-forward into main, but task/mars-5311e0be was never advanced).
 *   - git log main..task/mars-5311e0be → 1 commit
 *   - git log task/mars-5311e0be..main → 18 commits
 *
 * Path (a) "land into main" remains rejected: the work is already on main.
 * Replaying 1d1f8ef on top would either be empty after rebase or, worse,
 * reintroduce the pre-resolution `conversation` field and break the
 * refactor that the rebased commit absorbed.
 *
 * Path (b) "mark failed" remains rejected: the task SHIPPED. status='done'
 * is the correct record. Flipping it to 'failed' would lie in the queue
 * and corrupt success-rate metrics, retry signals, and fix-for chains.
 *
 * This script re-raises the same fingerprint (kind=desync,
 * signature=desync:mars-5311e0be:rebase-landed-ref-stale) so that the
 * existing inbox row's seen_count is incremented and last_seen_at is
 * refreshed, matching the precedent set by the re-confirm self-heal
 * commits for desyncs 0f203b55 and fe24b3c6.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-reconfirm-desync-5311e0be.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-f794be38'
const PRIOR_SELF_HEAL_TASK_ID = 'mars-f7a7483e'
const PRIOR_INBOX_ID = 'ecdd51fb'
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
    title: `Desync re-confirm: task ${TARGET_TASK_ID} landed via rebase under a different SHA`,
    body: [
      `Self-heal task ${SELF_HEAL_TASK_ID} re-confirms the desync escalation`,
      `originally raised by ${PRIOR_SELF_HEAL_TASK_ID} as inbox ${PRIOR_INBOX_ID}.`,
      'The shape and conclusion are unchanged; neither prescribed self-heal',
      'path applies, so this re-raise simply bumps seen_count on the open',
      'inbox row.',
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP} (1 commit ahead of`,
      `merge-base ${MERGE_BASE}). Main is 18 commits ahead.`,
      '',
      'The logical work of this task IS on main: commit',
      `${REBASED_SHA_ON_MAIN} ("feat(orchestrator): stamp every Mastra`,
      'span with originId for arc-level timelines") has the same author,',
      'timestamp, message, and file list as the task-branch commit. The',
      `orchestrator created ${REBASE_BRANCH} (still pointing at`,
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
      branchAheadOfMain:
        '1 commit (1d1f8ef, content-equivalent to 73921cc on main modulo one resolved hunk)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      priorSelfHealTaskId: PRIOR_SELF_HEAL_TASK_ID,
      priorInboxId: PRIOR_INBOX_ID,
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
      script: 'orchestrator/scripts/inbox-reconfirm-desync-5311e0be.ts',
      precedent: [
        'orchestrator/scripts/inbox-raise-desync-5311e0be.ts',
        'commit 9b0af4b chore(self-heal): re-confirm desync 0f203b55 stays unhealable (3rd pass)',
        'commit 147da60 chore(self-heal): re-confirm desync fe24b3c6 stays unhealable (never-...)',
      ],
      shapeNote:
        'rebase-landed-ref-stale: task LANDED via a rebase branch but the original task ref was never updated. Distinct from never-advanced + purged-row precedent.',
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync:${TARGET_TASK_ID}:rebase-landed-ref-stale`,
    occurrence: {
      at: new Date().toISOString(),
      selfHealTaskId: SELF_HEAL_TASK_ID,
      observation:
        're-confirmed: task-branch tip 1d1f8ef still not reachable from main; logical content already shipped as 73921cc; both prescribed paths still rejected.',
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
