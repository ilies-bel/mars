/**
 * Self-heal re-confirmation (9th pass) for task mars-5311e0be.
 *
 * Same "rebase-landed-ref-stale" desync, originally raised by self-heal
 * mars-f7a7483e as inbox ecdd51fb (still open) and re-confirmed by every
 * subsequent pass (mars-18ceada3, mars-c36d36d0, mars-f794be38,
 * mars-7d1edb09, mars-5b8aace9, mars-08c96e5a, mars-e1b7dd50). This 9th
 * pass runs as self-heal task mars-5c77d999.
 *
 * Note on ordering: this 9th pass and the immediately-prior 8th pass
 * (mars-e1b7dd50, commit 0b4aca7) ran nearly concurrently. The 8th pass
 * landed first and bumped seen_count 32 → 33. This 9th pass then bumped
 * seen_count 33 → 34. The worktree for mars-5c77d999 was auto-collected
 * (no committed changes from inside it) before this commit was authored,
 * so the audit trail is recorded directly on main.
 *
 * Re-verified during this pass:
 *   - task/mars-5311e0be tip = 1d1f8ef0a4b0faaf197a122e18f18976ef676eb1
 *   - main contains 73921cca6872c039e461dcbf64c2e20814a87552 with
 *     identical author, identical commit timestamp, identical message,
 *     and identical 8-file diffstat (311 insertions, 9 deletions).
 *   - rebase-5311e0be still points at 73921cc.
 *   - git log main..task/mars-5311e0be → 1 commit (1d1f8ef).
 *   - git log task/mars-5311e0be..main → 30 commits (was 28 at the 7th
 *     pass; main keeps advancing, including the self-heal trail itself).
 *   - Inbox row ecdd51fb open with seen_count=33 prior to this pass
 *     (bumped to 34 by this pass).
 *
 * Path (a) "land into main" still rejected: the work is already on main.
 * Path (b) "mark failed" still rejected: the task SHIPPED; status='done'
 * is the correct record.
 *
 * This pass does NOT re-run raiseInboxItem (the 8th pass already did, and
 * this same self-heal session already incremented seen_count to 34 before
 * the file was authored). The script body is preserved for audit-trail
 * symmetry with prior passes; running it would simply bump to 35.
 *
 * Run from `orchestrator/`:
 *   MARS_REPO=/Users/ib472e5l/project/perso/mars-framework \
 *     npx tsx scripts/inbox-reconfirm-desync-5311e0be-9th.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const SELF_HEAL_TASK_ID = 'mars-5c77d999'
const PRIOR_SELF_HEAL_TASK_IDS = [
  'mars-f7a7483e',
  'mars-18ceada3',
  'mars-c36d36d0',
  'mars-f794be38',
  'mars-7d1edb09',
  'mars-5b8aace9',
  'mars-08c96e5a',
  'mars-e1b7dd50',
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
    title: `Desync re-confirm (9th pass): task ${TARGET_TASK_ID} landed via rebase under a different SHA`,
    body: [
      `Self-heal task ${SELF_HEAL_TASK_ID} re-confirms (ninth pass) the`,
      `desync escalation originally raised by ${PRIOR_SELF_HEAL_TASK_IDS[0]}`,
      `as inbox ${PRIOR_INBOX_ID}, and re-confirmed by`,
      `${PRIOR_SELF_HEAL_TASK_IDS.slice(1).join(', ')}.`,
      'The shape and conclusion are unchanged; neither prescribed self-heal',
      'path applies.',
      '',
      'This 9th pass ran nearly concurrently with the 8th pass',
      '(mars-e1b7dd50, commit 0b4aca7). The 8th pass landed first; this',
      'pass then re-ran raiseInboxItem and bumped seen_count 33 → 34.',
      'The worktree for mars-5c77d999 was auto-collected before commit, so',
      'the audit trail is recorded directly on main.',
      '',
      `Branch ${TARGET_BRANCH} tip = ${BRANCH_TIP} (1 commit ahead of`,
      `merge-base ${MERGE_BASE}). Main is now 30 commits ahead.`,
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
      'and stop dispatching repeat self-heal tasks against it. Nine passes',
      '(two of them concurrent in the same minute) is well past the point',
      'at which the auto-detection rule should land.',
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
      mainAheadOfBranch: '30 commits',
      branchAheadOfMain:
        '1 commit (1d1f8ef, content-equivalent to 73921cc on main modulo one resolved hunk in implement-workflow.ts)',
      selfHealTaskId: SELF_HEAL_TASK_ID,
      priorSelfHealTaskIds: PRIOR_SELF_HEAL_TASK_IDS,
      priorInboxId: PRIOR_INBOX_ID,
      passNumber: 9,
      contentDifference:
        'orchestrator/src/mastra/workflows/implement-workflow.ts: rebased version replaces `conversation` field with `usage` (interim refactor on main, later codified by e5c3a6a).',
      concurrencyNote:
        '8th pass (mars-e1b7dd50, commit 0b4aca7) and 9th pass (mars-5c77d999, this commit) ran nearly concurrently; 8th pass landed first and bumped 32→33, 9th pass then bumped 33→34.',
      cleanupCommands: [
        `git worktree remove --force ${ORPHAN_WORKTREE}`,
        `git branch -D ${TARGET_BRANCH}`,
        `git branch -D ${REBASE_BRANCH}`,
      ],
      followUp:
        'Add merged_sha column on tasks (or auto-update task ref post-merge) so the sweeper can detect rebase-landed-but-ref-stale tasks without manual triage. Two near-concurrent self-heal passes against the same row in one minute is exactly the wasted-cycle pattern this fix would eliminate.',
    },
    context: {
      script: 'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-9th.ts',
      precedent: [
        'orchestrator/scripts/inbox-raise-desync-5311e0be.ts (1st pass — raises ecdd51fb)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be.ts (2nd pass)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-3rd.ts (3rd pass)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-4th.ts (4th pass)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-5th.ts (5th pass)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-6th.ts (6th pass)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-7th.ts (7th pass)',
        'orchestrator/scripts/inbox-reconfirm-desync-5311e0be-8th.ts (8th pass — mars-e1b7dd50, commit 0b4aca7)',
        'commit 6f8583c chore(self-heal): re-confirm desync mars-5311e0be stays unhealable (7th pass)',
        'commit 0b4aca7 chore(self-heal): re-confirm desync mars-5311e0be stays unhealable (8th pass)',
      ],
      shapeNote:
        'rebase-landed-ref-stale: task LANDED via a rebase branch but the original task ref was never updated. Distinct from never-advanced + purged-row precedent.',
    },
    raisedBy: SELF_HEAL_TASK_ID,
    signature: `desync:${TARGET_TASK_ID}:rebase-landed-ref-stale`,
    occurrence: {
      at: new Date().toISOString(),
      selfHealTaskId: SELF_HEAL_TASK_ID,
      passNumber: 9,
      observation:
        're-confirmed (9th pass, ran near-concurrent with 8th): task-branch tip 1d1f8ef still not reachable from main; logical content already shipped as 73921cc; both prescribed paths still rejected; main now 30 commits ahead; seen_count 32 → 33 (8th pass) → 34 (9th pass).',
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
