/**
 * Self-heal re-confirmation (3rd pass) for task mars-5311e0be.
 *
 * The desync between mars (status='done' on mars-5311e0be) and git
 * (task/mars-5311e0be tip not reachable from main) is the same
 * "rebase-landed-ref-stale" shape already escalated by the first
 * self-heal pass (mars-f7a7483e, inbox item ecdd51fb, still open),
 * and re-confirmed by the second pass (mars-18ceada3, commit d67fbe5).
 *
 * Confirmed during this third self-heal pass (task mars-c36d36d0):
 *   - task/mars-5311e0be tip = 1d1f8ef0a4b0faaf197a122e18f18976ef676eb1
 *   - main contains 73921cca6872c039e461dcbf64c2e20814a87552, with
 *     identical author (Iliès Beldjilali), identical commit timestamp
 *     (Sat May 9 18:32:30 2026 +0200), identical message, and identical
 *     8-file diffstat (311 insertions, 9 deletions).
 *   - rebase-5311e0be ref still pointing at 73921cc (the rebase landed
 *     via fast-forward into main, but task/mars-5311e0be was never
 *     advanced to follow the rebase).
 *   - git log main..task/mars-5311e0be → 1 commit
 *   - git log task/mars-5311e0be..main → 25 commits (was 18 at first
 *     pass; main has continued to advance — including the 1509f97 /
 *     d67fbe5 / 7d1ee88 self-heal trail itself).
 *   - tree SHAs differ (481f03a5 on task, 3643635a on main) because
 *     1d1f8ef sits on a stale parent; the *patch* differs only in one
 *     hunk in orchestrator/src/mastra/workflows/implement-workflow.ts
 *     where the post-rebase version replaces a `conversation` field
 *     with `usage` — exactly the change later codified by main commit
 *     e5c3a6a "perf(workflow): stop duplicating Claude conversation
 *     into DuckDB".
 *
 * Path (a) "land into main" remains rejected: the work is already on
 * main. Replaying 1d1f8ef would either be empty after rebase or, worse,
 * reintroduce the pre-resolution `conversation` field and regress the
 * e5c3a6a perf refactor that the rebased commit absorbed.
 *
 * Path (b) "mark failed" remains rejected: the task SHIPPED. status='done'
 * is the correct record. Flipping it to 'failed' would lie in the queue
 * and corrupt success-rate metrics, retry signals, and fix-for chains.
 *
 * This script re-raises the same fingerprint (kind=desync,
 * signature=desync:mars-5311e0be:rebase-landed-ref-stale) so that the
 * existing inbox row's seen_count is incremented and last_seen_at is
 * refreshed, matching the precedent set by the prior re-confirm self-heal
 * commits (d67fbe5, 7d1ee88) for this same desync.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-reconfirm-desync-5311e0be-3rd.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-c36d36d0'
const PRIOR_SELF_HEAL_TASK_IDS = ['mars-f7a7483e', 'mars-18ceada3']
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
    title: `Desync re-confirm (3rd pass): task ${TARGET_TASK_ID} landed via rebase under a different SHA`,
    body: [
      `Self-heal task ${SELF_HEAL_TASK_ID} re-confirms (third pass) the desync`,
      `escalation originally raised by ${PRIOR_SELF_HEAL_TASK_IDS[0]} as inbox`,
      `${PRIOR_INBOX_ID}, and re-confirmed by ${PRIOR_SELF_HEAL_TASK_IDS[1]}.`,
      'The shape and conclusion are unchanged; neither prescribed self-heal',
      'path applies, so this re-raise simply bumps seen_count on the open',
      'inbox row.',
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP} (1 commit ahead of`,
      `merge-base ${MERGE_BASE}). Main is now 25 commits ahead (was 18`,
      'at the first pass; main has continued advancing, including the',
      'self-heal trail for this very desync).',
      '',
      'The logical work of this task IS on main: commit',
      `${REBASED_SHA_ON_MAIN} ("feat(orchestrator): stamp every Mastra`,
      'span with originId for arc-level timelines") has identical author,',
      'identical timestamp, identical message, and identical 8-file diffstat',
      '(311 insertions, 9 deletions) as the task-branch commit. The',
      `orchestrator created ${REBASE_BRANCH} (still pointing at`,
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
      'Longer-term, the orchestrator should either record the rebased SHA on',
      'the tasks row (e.g. a merged_sha column) or fast-forward the original',
      'task ref to the rebased SHA after merge, so the sweeper can recognise',
      'this rebase-landed-but-ref-stale case without operator intervention',
      'and stop dispatching repeat self-heal tasks against it.',
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
      mainAheadOfBranch: '25 commits (was 18 at first pass)',
      branchAheadOfMain:
        '1 commit (1d1f8ef, content-equivalent to 73921cc on main modulo one resolved hunk in implement-workflow.ts)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      priorSelfHealTaskIds: PRIOR_SELF_HEAL_TASK_IDS,
      priorInboxId: PRIOR_INBOX_ID,
      contentDifference:
        'orchestrator/src/mastra/workflows/implement-workflow.ts: rebased version replaces `conversation` field with `usage` (interim refactor on main, later codified by e5c3a6a).',
      cleanupCommands: [
        `git worktree remove --force ${ORPHAN_WORKTREE}`,
        `git branch -D ${TARGET_BRANCH}`,
        `git branch -D ${REBASE_BRANCH}`,
      ],
      followUp:
        'Add merged_sha column on tasks (or auto-update task ref post-merge) so the sweeper can detect rebase-landed-but-ref-stale tasks without manual triage. The repeat self-heal dispatches against this row are wasted cycles.',
    },
    context: {
      script: 'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-3rd.ts',
      precedent: [
        'orchestrator/scripts/inbox-raise-desync-5311e0be.ts (1st pass — raises ecdd51fb)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be.ts (2nd pass)',
        'commit 1509f97 chore(self-heal): raise inbox ecdd51fb for desync mars-5311e0be (rebase-landed-ref-stale)',
        'commit d67fbe5 chore(self-heal): re-confirm desync mars-5311e0be stays unhealable (rebase-landed-ref-stale; bumps seen_count on open inbox ecdd51fb)',
        'commit 7d1ee88 chore(self-heal): re-confirm desync mars-5311e0be from second self-heal pass',
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
        're-confirmed (3rd pass): task-branch tip 1d1f8ef still not reachable from main; logical content already shipped as 73921cc; the one-hunk delta matches the post-merge perf refactor e5c3a6a; both prescribed paths still rejected.',
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
