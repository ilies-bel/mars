/**
 * Self-heal re-confirmation (6th pass) for task mars-5311e0be.
 *
 * Same "rebase-landed-ref-stale" desync, originally raised by self-heal
 * mars-f7a7483e as inbox ecdd51fb (still open) and re-confirmed by every
 * subsequent pass (mars-18ceada3, mars-c36d36d0, mars-f794be38,
 * mars-7d1edb09). This 6th pass runs as self-heal task mars-5b8aace9.
 *
 * Re-verified during this pass:
 *   - task/mars-5311e0be tip = 1d1f8ef0a4b0faaf197a122e18f18976ef676eb1
 *   - main contains 73921cca6872c039e461dcbf64c2e20814a87552 with
 *     identical author, identical commit timestamp
 *     (Sat May 9 18:32:30 2026 +0200), identical message, and identical
 *     8-file diffstat (311 insertions, 9 deletions).
 *   - rebase-5311e0be still points at 73921cc.
 *   - git log main..task/mars-5311e0be → 1 commit (1d1f8ef).
 *   - git log task/mars-5311e0be..main → 26 commits (was 25 at the 3rd
 *     pass; main keeps advancing, including the self-heal trail itself).
 *   - Existing inbox row ecdd51fb open with seen_count=28 prior to this
 *     pass.
 *
 * Path (a) "land into main" still rejected: the work is already on main.
 * Path (b) "mark failed" still rejected: the task SHIPPED; status='done'
 * is the correct record.
 *
 * Re-raise with the same fingerprint
 * (kind=desync, signature=desync:mars-5311e0be:rebase-landed-ref-stale)
 * so the existing inbox row's seen_count increments and last_seen_at
 * refreshes — matching the precedent of every prior re-confirm pass.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-reconfirm-desync-5311e0be-6th.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-5b8aace9'
const PRIOR_SELF_HEAL_TASK_IDS = [
  'mars-f7a7483e',
  'mars-18ceada3',
  'mars-c36d36d0',
  'mars-f794be38',
  'mars-7d1edb09',
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
    title: `Desync re-confirm (6th pass): task ${TARGET_TASK_ID} landed via rebase under a different SHA`,
    body: [
      `Self-heal task ${SELF_HEAL_TASK_ID} re-confirms (sixth pass) the`,
      `desync escalation originally raised by ${PRIOR_SELF_HEAL_TASK_IDS[0]}`,
      `as inbox ${PRIOR_INBOX_ID}, and re-confirmed by`,
      `${PRIOR_SELF_HEAL_TASK_IDS.slice(1).join(', ')}.`,
      'The shape and conclusion are unchanged; neither prescribed self-heal',
      'path applies, so this re-raise simply bumps seen_count on the open',
      'inbox row.',
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP} (1 commit ahead of`,
      `merge-base ${MERGE_BASE}). Main is now 26 commits ahead.`,
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
      'Longer-term, the orchestrator should either record the rebased SHA on',
      'the tasks row (e.g. a merged_sha column) or fast-forward the original',
      'task ref to the rebased SHA after merge, so the sweeper can recognise',
      'this rebase-landed-but-ref-stale case without operator intervention',
      'and stop dispatching repeat self-heal tasks against it. Six passes is',
      'enough signal that the auto-detection rule is missing.',
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
      mainAheadOfBranch: '26 commits',
      branchAheadOfMain:
        '1 commit (1d1f8ef, content-equivalent to 73921cc on main modulo one resolved hunk in implement-workflow.ts)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      priorSelfHealTaskIds: PRIOR_SELF_HEAL_TASK_IDS,
      priorInboxId: PRIOR_INBOX_ID,
      passNumber: 6,
      contentDifference:
        'orchestrator/src/mastra/workflows/implement-workflow.ts: rebased version replaces `conversation` field with `usage` (interim refactor on main, later codified by e5c3a6a).',
      cleanupCommands: [
        `git worktree remove --force ${ORPHAN_WORKTREE}`,
        `git branch -D ${TARGET_BRANCH}`,
        `git branch -D ${REBASE_BRANCH}`,
      ],
      followUp:
        'Add merged_sha column on tasks (or auto-update task ref post-merge) so the sweeper can detect rebase-landed-but-ref-stale tasks without manual triage. The repeat self-heal dispatches against this row are wasted cycles — six passes and counting.',
    },
    context: {
      script: 'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-6th.ts',
      precedent: [
        'orchestrator/scripts/inbox-raise-desync-5311e0be.ts (1st pass — raises ecdd51fb)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be.ts (2nd pass)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-3rd.ts (3rd pass)',
        'commit 1509f97 chore(self-heal): raise inbox ecdd51fb for desync mars-5311e0be (rebase-landed-ref-stale)',
        'commit d67fbe5 chore(self-heal): re-confirm desync mars-5311e0be stays unhealable (rebase-landed-ref-stale; bumps seen_count on open inbox ecdd51fb)',
        'commit 7d1ee88 chore(self-heal): re-confirm desync mars-5311e0be from second self-heal pass',
        'commit 62cd606 chore(self-heal): re-confirm desync mars-5311e0be stays unhealable (4th)',
        'commit c74a52c chore(self-heal): re-confirm desync mars-5311e0be (3rd pass) stays unhealable',
        'commit 961425d chore(self-heal): re-confirm desync mars-5311e0be stays unhealable (5th — bumps seen_count to 27 + mars-7d1edb09 pass)',
      ],
      shapeNote:
        'rebase-landed-ref-stale: task LANDED via a rebase branch but the original task ref was never updated. Distinct from never-advanced + purged-row precedent.',
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync:${TARGET_TASK_ID}:rebase-landed-ref-stale`,
    occurrence: {
      at: new Date().toISOString(),
      selfHealTaskId: SELF_HEAL_TASK_ID,
      passNumber: 6,
      observation:
        're-confirmed (6th pass): task-branch tip 1d1f8ef still not reachable from main; logical content already shipped as 73921cc; the one-hunk delta matches the post-merge perf refactor e5c3a6a; both prescribed paths still rejected; main now 26 commits ahead.',
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
