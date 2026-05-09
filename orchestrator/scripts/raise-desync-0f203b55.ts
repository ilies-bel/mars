import { raiseInboxItem } from '../src/mastra/lib/inbox'

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync-self-heal-ambiguous',
    category: 'daemon',
    priority: 'high',
    title:
      'Desync self-heal for 0f203b55: branch already landed, queue row already purged, neither (a) nor (b) fits',
    body: [
      'Self-heal task for 0f203b55 cannot be resolved by either of the two prompt-prescribed paths.',
      '',
      'Findings (worktree task/mars-01132135, main=8cce66b):',
      '- task/0f203b55 tip = d3322b5 ("feat(orchestrator): write per-scope AGENTS.md from mars init"). This is the same merged commit that task/fec8d7af, task/0ee5ef07, task/0c76473f, etc. landed at — many self-heal aliases collapse onto the same already-merged tip.',
      '- git rev-list --left-right --count main...task/0f203b55 = 25  0  → branch is strictly an ancestor of main (0 ahead, 25 behind).',
      '- git merge-base --is-ancestor task/0f203b55 main → YES.',
      '- queue.db (current) has NO row for 0f203b55. The row was purged in a prior self-heal cleanup. queue.db.bak.selfheal-purge still has it: id=0f203b55, status=failed, branch=task/0f203b55, error="daemon restart while task was running".',
      '- watch.log: "[2026-05-09T07:36:38.392Z] [implement] 0f203b55 dispatching" then "[2026-05-09T08:25:23.350Z] [reconcile] task 0f203b55 was running on prior daemon; marking failed". Same reconcile pathology as fec8d7af and 0ee5ef07: the row was conservatively flipped to failed on daemon restart even though the branch later landed.',
      '- 0f203b55 was itself enqueued by the sweeper as a self-heal for task/50ed4fa2 ("[2026-05-09T07:36:38.381Z] [sweeper] desync task/50ed4fa2 (mars=failed, merged=true); enqueued self-heal task 0f203b55"), so this is a self-heal for a self-heal — same shape as fec8d7af (993649f7) and 0ee5ef07 (276089ce).',
      '- sweeper.log shows 16 re-fires for 0f203b55 between 2026-05-09T12:47Z and 2026-05-09T15:26Z (mars-a81e5a6a, mars-01132135 [this one], mars-215ebf76, mars-3e6ccdaf, mars-93d1f0e6, mars-f0a70b52, mars-43252a17, mars-018967ec, mars-3efcac34, mars-f5e875ee, mars-aaf31fee, mars-c8943486, mars-22a5cc43, mars-8810f370, mars-c827393b — count includes this worktree).',
      '',
      'Why the two prescribed options do not fit:',
      "- (a) 'land cleanly into main (rebase + fast-forward)': the branch is 0 ahead of main; its tip is already an ancestor of main HEAD. There is nothing to fast-forward. `git log main..task/0f203b55` is empty.",
      "- (b) 'update task row to status=failed with explanation': there is no row to update. queue.db has no entry for 0f203b55; a previous self-heal pass already purged it (backup at .mars/queue.db.bak.selfheal-purge confirms the row was status=failed pre-purge, error='daemon restart while task was running').",
      '',
      'No prior inbox item exists for 0f203b55 (state.db inbox_items title/body/payload/context searches all returned 0 rows), so this is the first inbox raise for this desync chain.',
      '',
      'This is yet another instance of the same pattern already raised for fec8d7af (inbox decb6261), 0ee5ef07 (inbox 18adba6c), 0c76473f (inbox 91f333a0), 0e287883 (inbox 6547339c), and others — all branches share the same merged tip d3322b5. The shared root cause is the daemon-restart reconcile path flipping running tasks to failed without ancestry rechecking, plus the sweeper continuing to fire on phantom rows that have already been purged.',
      '',
      'Suggested resolution paths for whoever picks this up:',
      "- The sweeper desync detector should treat 'branch tip is ancestor of main HEAD' AND 'no queue.db row exists' as a NO-OP, not a desync. Currently it keeps re-firing on phantom rows that no longer exist.",
      "- Or: the sweeper should join against queue.db tasks before reporting desync, and skip branches whose task row has been purged.",
      "- Same fix would also stop the re-fire pattern on fec8d7af, 0ee5ef07, 0b46d264, 0b454825, 0a820a95, ff8c6206, 0451b2bb, 0c76473f, ff08b9a9, ff5710b2, ccb32d6b, etc., all visible in recent self-heal commits with the same shape.",
      "- Also worth investigating: why the original reconcile flipped 0f203b55 (and fec8d7af, 0ee5ef07, …) to 'failed' on daemon restart instead of re-checking ancestry against main on resume — that initial mis-classification is the upstream cause of every subsequent self-heal cascade.",
    ].join('\n'),
    payload: {
      taskId: '0f203b55',
      branch: 'task/0f203b55',
      branchTip: 'd3322b550388da6b7cd8e30959960c27262136d4',
      mainHead: '8cce66b5d2bd871f35eaad81d0d0eb8e8b551964',
      currentStatus: 'no-row-in-queue',
      pre_purge_status: 'failed',
      pre_purge_error: 'daemon restart while task was running',
      mergedIntoMain: true,
      commitsAhead: 0,
      commitsBehind: 25,
      worktreePath:
        '/Users/ib472e5l/project/perso/mars-framework/.mars/worktrees/0f203b55',
      queueBackupPath:
        '/Users/ib472e5l/project/perso/mars-framework/.mars/queue.db.bak.selfheal-purge',
      reconcileLogLine:
        '[2026-05-09T08:25:23.350Z] [reconcile] task 0f203b55 was running on prior daemon; marking failed',
      originatedAsSelfHealFor: '50ed4fa2',
      sharedTipWith: ['fec8d7af', '0ee5ef07', '0c76473f'],
      relatedInboxItems: ['decb6261', '18adba6c', '91f333a0'],
      selfHealRespawnIds: [
        'mars-a81e5a6a',
        'mars-01132135',
        'mars-215ebf76',
        'mars-3e6ccdaf',
        'mars-93d1f0e6',
        'mars-f0a70b52',
        'mars-43252a17',
        'mars-018967ec',
        'mars-3efcac34',
        'mars-f5e875ee',
        'mars-aaf31fee',
        'mars-c8943486',
        'mars-22a5cc43',
        'mars-8810f370',
        'mars-c827393b',
      ],
      selfHealRespawnCount: 16,
    },
    context: {
      taskId: '0f203b55',
      branch: 'task/0f203b55',
      reportedBy: 'self-heal task task/mars-01132135',
    },
    raisedBy: 'self-heal:mars-01132135',
    signature: 'desync-self-heal-ambiguous:0f203b55',
  })
  process.stdout.write(`raised inbox item ${id}\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`failed: ${(err as Error).message}\n`)
  process.exit(1)
})
