/**
 * One-shot refresher for the open desync inbox item tracking task 054dc6d5.
 *
 * Task 054dc6d5 is `status='failed'` in queue.db (orchestrator merge step
 * aborted on 2026-05-07T20:22:23Z when vcs-supervisor "Vega" crashed
 * parsing its own SKILL.md frontmatter as a CLI flag — `unknown option
 * ---`). 2.5 minutes later (2026-05-07T20:24:53Z) a human merged
 * `task/054dc6d5` (tip c7b18507) into main out-of-band via merge commit
 * 569027d9. The desync detector keeps firing because:
 *
 *   - branch IS an ancestor of main (0 commits ahead),
 *   - queue row is `failed` and the error column already documents (b).
 *
 * Neither resolution option from the self-heal prompt is correct here:
 * (a) re-landing is a no-op (already merged), and (b) keeping
 * `status='failed'` does not stop the desync detector from firing every
 * sweeper tick. Until the dedup fix and strict-landed fix on parallel
 * task branches land on main, every pass will re-enqueue another
 * self-heal task. The right thing to do per the task contract is
 * escalate to the existing inbox item (338eb620) — `raiseInboxItem`
 * dedupes by `(kind, signature)` fingerprint, so re-runs only bump
 * `seen_count` and append an occurrence rather than spawning new rows.
 *
 * This is the **fourth** self-heal pass on this same desync. Prior
 * refreshers landed on parallel task branches but not yet on main:
 *   - f6483c1 (first pass, task/e2cb69a2) — wrote the original script
 *     and identified the human merge.
 *   - bff2e3f (third pass, task/7a245c27) — re-confirmed the diagnosis
 *     after the second pass.
 *
 * Run from the `orchestrator/` directory:
 *   npx tsx scripts/refresh-desync-054dc6d5.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const TASK_ID = '054dc6d5'
const BRANCH_TIP = 'c7b18507ea6d05ced244574538c27fe86a8f35ff'
const HUMAN_MERGE = '569027d97078aefcc8e6f4078f30d5c12e98f2d6'
const SIGNATURE = `desync:${TASK_ID}:${BRANCH_TIP}:${HUMAN_MERGE}`

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync',
    category: 'orchestrator',
    priority: 'high',
    title: `Desync: task ${TASK_ID} failed but task/${TASK_ID} is on main`,
    body: [
      `Task ${TASK_ID} reports status='failed' in queue.db, but its branch`,
      `task/${TASK_ID} (tip ${BRANCH_TIP}) IS an ancestor of main (0 commits`,
      `ahead). The branch landed via human merge ${HUMAN_MERGE} on`,
      `2026-05-07T20:24:53Z, ~2.5 minutes after vcs-supervisor (Vega) crashed`,
      `parsing its own SKILL.md frontmatter as a CLI flag (unknown option ---).`,
      ``,
      `Neither self-heal option is correct: (a) re-landing is a no-op, and`,
      `(b) keeping status='failed' does not stop the desync detector from`,
      `re-firing every sweeper tick. The queue row's error column already`,
      `documents the chosen path (b). The fixes that would silence the`,
      `detector — sweeper dedup and strict-landed checks — live on parallel`,
      `task branches that have not yet landed on main. Until they do, this`,
      `inbox item is the durable record of the desync; the fingerprint dedup`,
      `keeps the inbox from growing unbounded.`,
    ].join('\n'),
    payload: {
      taskId: TASK_ID,
      branch: `task/${TASK_ID}`,
      branchTip: BRANCH_TIP,
      humanMergeCommit: HUMAN_MERGE,
      humanMergeAt: '2026-05-07T20:24:53Z',
      orchestratorFailureAt: '2026-05-07T20:22:23.333Z',
      orchestratorFailureCause:
        'vcs-supervisor parsed SKILL.md frontmatter as CLI flag (unknown option ---)',
      currentTaskStatus: 'failed',
      branchAncestorOfMain: true,
      commitsAhead: 0,
      resolutionRecommendation:
        'leave status=failed; rely on inbox item; wait for sweeper dedup + strict-landed fixes to land on main',
      priorSelfHealCommits: ['f6483c1', 'bff2e3f'],
    },
    context: {
      script: 'orchestrator/scripts/refresh-desync-054dc6d5.ts',
      pass: 'fourth',
    },
    raisedBy: 'self-heal:054dc6d5:pass-4',
    signature: SIGNATURE,
    occurrence: {
      at: new Date().toISOString(),
      pass: 'fourth',
      note: 'Re-investigated; same diagnosis. No queue mutation.',
    },
  })
  console.log(`refreshed inbox item: ${id}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
