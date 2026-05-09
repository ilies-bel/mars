/**
 * Self-heal re-confirmation (12th pass) for task mars-5311e0be.
 *
 * Same "rebase-landed-ref-stale" desync, originally raised by self-heal
 * mars-f7a7483e as inbox ecdd51fb (still open) and re-confirmed by every
 * subsequent pass (mars-18ceada3, mars-c36d36d0, mars-f794be38,
 * mars-7d1edb09, mars-5b8aace9, mars-08c96e5a, mars-e1b7dd50,
 * mars-5c77d999, mars-924033ce, mars-08b123c5). This 12th pass runs as
 * self-heal task mars-79c559e1.
 *
 * Re-verified during this pass:
 *   - task/mars-5311e0be tip = 1d1f8ef0a4b0faaf197a122e18f18976ef676eb1
 *   - main contains 73921cca6872c039e461dcbf64c2e20814a87552 with
 *     identical author, identical commit timestamp, identical message,
 *     and identical 8-file diffstat (311 insertions, 9 deletions).
 *   - rebase-5311e0be still points at 73921cc.
 *   - git log main..task/mars-5311e0be → 1 commit (1d1f8ef).
 *   - Inbox row ecdd51fb open with seen_count=45 prior to this pass
 *     (last bumped at 2026-05-09T19:09:07 by 11th pass mars-08b123c5,
 *      commit e1c7e4a).
 *
 * Path (a) "land into main" still rejected: the work is already on main
 * as 73921cc.
 * Path (b) "mark failed" still rejected: the task SHIPPED; status='done'
 * is the correct record.
 *
 * Twelve passes against the same row in roughly three hours strongly
 * confirms the open follow-up: the orchestrator needs an auto-detection
 * rule for "rebase-landed-but-ref-stale" so the sweeper stops dispatching
 * self-heal tasks against rows whose logical content already shipped under
 * a different SHA. The fix shape (record merged_sha on the tasks row, or
 * fast-forward the task ref to the rebased SHA after merge) is recorded
 * in the inbox payload's followUp field on every pass.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-reconfirm-desync-5311e0be-12th.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-79c559e1'
const PRIOR_SELF_HEAL_TASK_IDS = [
  'mars-f7a7483e',
  'mars-18ceada3',
  'mars-c36d36d0',
  'mars-f794be38',
  'mars-7d1edb09',
  'mars-5b8aace9',
  'mars-08c96e5a',
  'mars-e1b7dd50',
  'mars-5c77d999',
  'mars-924033ce',
  'mars-08b123c5',
]
const PRIOR_INBOX_ID = 'ecdd51fb'
const TARGET_TASK_ID = 'mars-5311e0be'
const TARGET_BRANCH = 'task/mars-5311e0be'
const BRANCH_TIP = '1d1f8ef0a4b0faaf197a122e18f18976ef676eb1'
const MERGE_BASE = '35b880d2968126c616e4f967486516945b63876b'
const REBASE_BRANCH = 'rebase-5311e0be'
const REBASED_SHA_ON_MAIN = '73921cca6872c039e461dcbf64c2e20814a87552'
const PERF_REFACTOR_SHA_ON_MAIN = 'e5c3a6a'
const ORPHAN_WORKTREE = '.mars/worktrees/mars-5311e0be'

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync',
    category: 'orchestrator',
    priority: 'high',
    title: `Desync re-confirm (12th pass): task ${TARGET_TASK_ID} landed via rebase under a different SHA`,
    body: [
      `Self-heal task ${SELF_HEAL_TASK_ID} re-confirms (twelfth pass) the`,
      `desync escalation originally raised by ${PRIOR_SELF_HEAL_TASK_IDS[0]}`,
      `as inbox ${PRIOR_INBOX_ID}, and re-confirmed by`,
      `${PRIOR_SELF_HEAL_TASK_IDS.slice(1).join(', ')}.`,
      'The shape and conclusion are unchanged; neither prescribed self-heal',
      'path applies.',
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP} (1 commit ahead of`,
      `merge-base ${MERGE_BASE}).`,
      '',
      'The logical work of this task IS on main: commit',
      `${REBASED_SHA_ON_MAIN} ("feat(orchestrator): stamp every Mastra`,
      'span with originId for arc-level timelines") has identical author,',
      'identical timestamp, identical message, and identical 8-file diffstat',
      `(311 insertions, 9 deletions) as the task-branch tip ${BRANCH_TIP}.`,
      `The orchestrator created ${REBASE_BRANCH} (still pointing at`,
      `${REBASED_SHA_ON_MAIN}) and fast-forwarded that into main, but the`,
      `original ${TARGET_BRANCH} ref was never updated to follow the rebase.`,
      '',
      'The two commits differ by exactly one hunk in',
      'orchestrator/src/mastra/workflows/implement-workflow.ts, where the',
      'post-rebase version drops a `conversation` field in favour of',
      `\`usage\` — the same change later codified on main as ${PERF_REFACTOR_SHA_ON_MAIN}`,
      '"perf(workflow): stop duplicating Claude conversation into DuckDB".',
      '',
      'Path (a) — land branch into main: rejected. The work is already on',
      `main as ${REBASED_SHA_ON_MAIN}. Rebasing ${BRANCH_TIP} and`,
      'fast-forwarding would either produce a duplicate-content commit or',
      `reintroduce the pre-resolution \`conversation\` field, regressing`,
      `the ${PERF_REFACTOR_SHA_ON_MAIN} perf refactor that the rebased`,
      'commit absorbed.',
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
      'Twelve self-heal passes against this row in roughly three hours is',
      'wasted dispatch volume; the orchestrator needs an auto-detection',
      'rule for "rebase-landed-but-ref-stale" (record merged_sha on the',
      'tasks row, or fast-forward the task ref to the rebased SHA after',
      'merge) so the sweeper stops queuing this same self-heal job.',
    ].join('\n'),
    payload: {
      taskId: TARGET_TASK_ID,
      branch: TARGET_BRANCH,
      branchTip: BRANCH_TIP,
      mergeBase: MERGE_BASE,
      rebaseBranch: REBASE_BRANCH,
      rebasedShaOnMain: REBASED_SHA_ON_MAIN,
      perfRefactorOnMain: PERF_REFACTOR_SHA_ON_MAIN,
      orphanWorktree: ORPHAN_WORKTREE,
      currentStatus: 'done',
      branchAheadOfMain:
        '1 commit (1d1f8ef, content-equivalent to 73921cc on main modulo one resolved hunk in implement-workflow.ts)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      priorSelfHealTaskIds: PRIOR_SELF_HEAL_TASK_IDS,
      priorInboxId: PRIOR_INBOX_ID,
      passNumber: 12,
      contentDifference:
        'orchestrator/src/mastra/workflows/implement-workflow.ts: rebased version replaces `conversation` field with `usage` (interim refactor on main, later codified by e5c3a6a).',
      cleanupCommands: [
        `git worktree remove --force ${ORPHAN_WORKTREE}`,
        `git branch -D ${TARGET_BRANCH}`,
        `git branch -D ${REBASE_BRANCH}`,
      ],
      followUp:
        'Add merged_sha column on tasks (or auto-update task ref post-merge) so the sweeper can detect rebase-landed-but-ref-stale tasks without manual triage. Twelve self-heal passes against the same row is exactly the wasted-cycle pattern this fix would eliminate.',
    },
    context: {
      script: 'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-12th.ts',
      shapeNote:
        'rebase-landed-ref-stale: task LANDED via a rebase branch but the original task ref was never updated. Distinct from never-advanced + purged-row precedent.',
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync:${TARGET_TASK_ID}:rebase-landed-ref-stale`,
    occurrence: {
      at: new Date().toISOString(),
      selfHealTaskId: SELF_HEAL_TASK_ID,
      passNumber: 12,
      observation:
        're-confirmed (12th pass): task-branch tip 1d1f8ef still not reachable from main; logical content already shipped as 73921cc; both prescribed paths still rejected; bumping seen_count from 45.',
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
