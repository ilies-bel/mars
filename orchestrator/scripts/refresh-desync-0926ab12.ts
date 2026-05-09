/**
 * One-shot refresher for the desync inbox item tracking task 0926ab12.
 *
 * Task 0926ab12 is `status='failed'` in queue.db with error column
 * `"daemon restart while task was running"`. The watch.log shows:
 *
 *   [2026-05-09T08:25:23.121Z] [implement] 0926ab12 dispatching
 *   [2026-05-09T12:46:53.679Z] [reconcile] task 0926ab12 was running on
 *                              prior daemon; marking failed
 *
 * The daemon restarted while 0926ab12 was running and the reconciler
 * marked it failed on the next boot. The branch task/0926ab12 was created
 * off main but no commit was ever produced (the worker never reached the
 * code/verify/merge steps). Branch tip = d3322b5 = the merge-base with
 * main. main has since advanced (current tip fb66c50), so the branch is
 * now trivially an ancestor of main with **zero unique commits**.
 *
 *   $ git rev-list main..task/0926ab12 | wc -l   # => 0
 *   $ git rev-list task/0926ab12..main | wc -l   # => non-zero
 *
 * The desync detector reads "branch is ancestor of main" as "branch
 * landed", but in this case it never moved — there is no work to land.
 * Neither resolution option from the self-heal prompt fits cleanly:
 *   (a) re-landing is a no-op (the branch has no commits beyond main).
 *   (b) the row is already `failed` and the error column already
 *       documents the daemon-restart cause.
 *
 * The right thing is to escalate to the inbox so the (kind, signature)
 * dedup keeps the inbox bounded while the sweeper's strict-landed check
 * (which would distinguish "0 commits ahead because never moved" from
 * "0 commits ahead because actually merged") is still in flight on
 * parallel branches.
 *
 * This is the **first** self-heal pass on 0926ab12. The 054dc6d5 case
 * (refresh-desync-054dc6d5.ts) is similar but had a real human
 * out-of-band merge; here the cause is a daemon crash mid-run.
 *
 * Run from the `orchestrator/` directory:
 *   npx tsx scripts/refresh-desync-0926ab12.ts
 */

import { raiseInboxItem } from '../src/mastra/lib/inbox'

const TASK_ID = '0926ab12'
const BRANCH_TIP = 'd3322b550388da6b7cd8e30959960c27262136d4'
const SIGNATURE = `desync:${TASK_ID}:${BRANCH_TIP}:no-unique-commits`

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync',
    category: 'orchestrator',
    priority: 'high',
    title: `Desync: task ${TASK_ID} failed (daemon restart) but task/${TASK_ID} reads as ancestor of main`,
    body: [
      `Task ${TASK_ID} reports status='failed' in queue.db with error`,
      `"daemon restart while task was running". The watch.log records the`,
      `dispatch at 2026-05-09T08:25:23Z and the reconciler marking it`,
      `failed at 2026-05-09T12:46:53Z on the next daemon boot.`,
      ``,
      `The desync detector flags this because task/${TASK_ID} is an`,
      `ancestor of main, but only trivially: the branch has ZERO unique`,
      `commits (git rev-list main..task/${TASK_ID} returns 0). Branch tip`,
      `${BRANCH_TIP.slice(0, 7)} = the merge-base with main. main has since`,
      `moved on, leaving the branch buried in main's history without ever`,
      `having advanced. There is no work to land.`,
      ``,
      `Neither self-heal option is correct: (a) re-landing is a no-op`,
      `(no commits to fast-forward), and (b) keeping status='failed' does`,
      `not stop the desync detector from re-firing every sweeper tick. The`,
      `queue row's error column already documents the chosen path (b).`,
      `Until the sweeper learns to distinguish "0 commits ahead because`,
      `never advanced" from "0 commits ahead because actually merged",`,
      `this inbox item is the durable record of the desync; fingerprint`,
      `dedup keeps the inbox from growing unbounded.`,
    ].join('\n'),
    payload: {
      taskId: TASK_ID,
      branch: `task/${TASK_ID}`,
      branchTip: BRANCH_TIP,
      branchTipEqualsMergeBase: true,
      commitsAhead: 0,
      currentTaskStatus: 'failed',
      currentTaskError: 'daemon restart while task was running',
      branchAncestorOfMain: true,
      orchestratorDispatchAt: '2026-05-09T08:25:23.121Z',
      orchestratorReconcileAt: '2026-05-09T12:46:53.679Z',
      cause:
        'daemon restarted while task was running; reconciler marked the row failed on next boot. The branch never produced a commit.',
      resolutionRecommendation:
        'leave status=failed; rely on inbox item; wait for sweeper "strict-landed" check (distinguishing never-advanced from truly-merged) to land on main',
      relatedSelfHealCases: ['054dc6d5'],
    },
    context: {
      script: 'orchestrator/scripts/refresh-desync-0926ab12.ts',
      pass: 'first',
    },
    raisedBy: `self-heal:${TASK_ID}:pass-1`,
    signature: SIGNATURE,
    occurrence: {
      at: new Date().toISOString(),
      pass: 'first',
      note: 'Investigated; branch has zero unique commits; queue row already records the daemon-restart cause. No queue mutation.',
    },
  })
  console.log(`refreshed inbox item: ${id}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
