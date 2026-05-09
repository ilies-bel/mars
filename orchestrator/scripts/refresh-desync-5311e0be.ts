/**
 * Self-heal re-confirmation for task mars-5311e0be (2nd pass).
 *
 * The first self-heal pass for this desync (mars-f7a7483e) raised inbox
 * ecdd51fb with reason `rebase-landed-ref-stale`, captured in
 * `inbox-raise-desync-5311e0be.ts` and shipped as commit 1509f97.
 *
 * This second pass (self-heal task mars-cca639b5) re-investigated and
 * confirms the same diagnosis still holds:
 *
 *   - task/mars-5311e0be tip = 1d1f8ef (1 commit ahead of merge-base 35b880d)
 *   - main is now 19 commits ahead of the task tip (was 18 at first pass —
 *     1509f97 itself plus normal traffic).
 *   - The work content of mars-5311e0be IS on main as 73921cc
 *     (identical message, author, timestamp, file list; one resolved hunk in
 *     orchestrator/src/mastra/workflows/implement-workflow.ts swapping
 *     `conversation` for `usage`).
 *   - The rebase-5311e0be ref still points at 73921cc.
 *   - tasks row for mars-5311e0be is still status='done' with no error,
 *     correctly reflecting that the work shipped.
 *
 * Neither prescribed self-heal path is safe (see the original script for the
 * full rationale):
 *   (a) Landing 1d1f8ef into main would either duplicate 73921cc or revert
 *       the conflict-resolved hunk, breaking the refactor.
 *   (b) Flipping status to 'failed' would lie in the queue — the task
 *       shipped and the user benefits from it.
 *
 * Calling raiseInboxItem with the same signature
 * `desync:mars-5311e0be:rebase-landed-ref-stale` deduplicates against the
 * existing ecdd51fb row and bumps its occurrence counter, leaving an audit
 * trail for this pass without spawning a duplicate inbox row.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/refresh-desync-5311e0be.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-cca639b5'
const TARGET_TASK_ID = 'mars-5311e0be'
const TARGET_BRANCH = 'task/mars-5311e0be'
const BRANCH_TIP = '1d1f8ef0a4b0faaf197a122e18f18976ef676eb1'
const MERGE_BASE = '35b880d2968126c616e4f967486516945b63876b'
const REBASE_BRANCH = 'rebase-5311e0be'
const REBASED_SHA_ON_MAIN = '73921cca6872c039e461dcbf64c2e20814a87552'
const ORPHAN_WORKTREE = '.mars/worktrees/mars-5311e0be'
const PRIOR_SELF_HEAL_TASK_ID = 'mars-f7a7483e'

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync',
    category: 'orchestrator',
    priority: 'high',
    title: `Desync escalation: task ${TARGET_TASK_ID} landed via rebase under a different SHA`,
    body: [
      `Self-heal task ${SELF_HEAL_TASK_ID} re-confirms the desync first`,
      `escalated by ${PRIOR_SELF_HEAL_TASK_ID}.`,
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP} (1 commit ahead of`,
      `merge-base ${MERGE_BASE}). Main is 19 commits ahead.`,
      '',
      'The logical work of this task IS on main: commit',
      `${REBASED_SHA_ON_MAIN} ("feat(orchestrator): stamp every Mastra`,
      'span with originId for arc-level timelines") has the same author,',
      'timestamp, message, and file list as the task-branch commit. The',
      `orchestrator created ${REBASE_BRANCH} (still pointing at`,
      `${REBASED_SHA_ON_MAIN}) and fast-forwarded that into main, but the`,
      `original ${TARGET_BRANCH} ref was never updated to follow the rebase.`,
      '',
      'Path (a) — land branch into main: still rejected. Rebasing',
      `${BRANCH_TIP} would duplicate ${REBASED_SHA_ON_MAIN} or reintroduce`,
      'the pre-resolution `conversation` field in implement-workflow.ts.',
      '',
      `Path (b) — set status='failed': still rejected. The task SHIPPED;`,
      "status='done' is correct.",
      '',
      `Operator cleanup is unchanged from the original ecdd51fb body.`,
      'No code change in this pass; this script exists as the audit-trail',
      'commit for the second self-heal pass and to bump the inbox',
      'occurrence counter via the deduplicating signature.',
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
      mainAheadOfBranch: '19 commits',
      branchAheadOfMain:
        '1 commit (1d1f8ef, content-equivalent to 73921cc on main modulo one resolved hunk)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      priorSelfHealTaskId: PRIOR_SELF_HEAL_TASK_ID,
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
      script: 'orchestrator/scripts/refresh-desync-5311e0be.ts',
      priorScript: 'orchestrator/scripts/inbox-raise-desync-5311e0be.ts',
      precedent: [
        'orchestrator/scripts/refresh-desync-0f203b55.ts',
        'orchestrator/scripts/refresh-desync-fe24b3c6.ts',
      ],
      shapeNote:
        'rebase-landed-ref-stale: distinct from never-advanced + purged-row. The task LANDED via a rebase branch but the original task ref was never updated.',
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync:${TARGET_TASK_ID}:rebase-landed-ref-stale`,
    occurrence: {
      at: new Date().toISOString(),
      selfHealTaskId: SELF_HEAL_TASK_ID,
      pass: 2,
      observation:
        'work content reachable on main as 73921cc via rebase-5311e0be; original task ref still at pre-rebase 1d1f8ef; main now 19 commits ahead',
    },
  })

  // eslint-disable-next-line no-console
  console.log(`refreshed inbox item ${id} for desync ${TARGET_TASK_ID}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
