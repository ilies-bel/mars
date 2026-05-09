import { raiseInboxItem } from '../src/mastra/lib/inbox'

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync-self-heal-ambiguous',
    category: 'daemon',
    priority: 'high',
    title:
      'Desync self-heal for fec8d7af: branch already landed, queue row already purged, neither (a) nor (b) fits',
    body: [
      'Self-heal task for fec8d7af cannot be resolved by either of the two prompt-prescribed paths.',
      '',
      'Findings (worktree task/mars-32f42ae8, main=d3322b5):',
      '- task/fec8d7af tip = d3322b5 ("feat(orchestrator): write per-scope AGENTS.md from mars init"), the current main HEAD.',
      '- git rev-list --left-right --count main...task/fec8d7af = 20  0  → branch is strictly an ancestor of main (0 ahead, 20 behind).',
      '- git merge-base main task/fec8d7af = d3322b5 (== branch tip == main HEAD).',
      '- queue.db (current) has NO row for fec8d7af. The row was purged in a prior self-heal cleanup; queue.db.bak.selfheal-purge still has it: status=failed, branch=task/fec8d7af, error="daemon restart while task was running".',
      '- watch.log: "[2026-05-09T07:36:45.400Z] [implement] fec8d7af dispatching" then "[2026-05-09T08:25:23.350Z] [reconcile] task fec8d7af was running on prior daemon; marking failed". The reconcile path conservatively flipped the row to failed even though the work later landed.',
      '- fec8d7af was itself enqueued by the sweeper as a self-heal for task/993649f7 ("[2026-05-09T07:36:45.395Z] [sweeper] desync task/993649f7 (mars=failed, merged=true); enqueued self-heal task fec8d7af"), so this is a self-heal for a self-heal.',
      '- sweeper.log shows the sweeper has now spawned 16 self-heal tasks for fec8d7af between 2026-05-09T13:07Z and 2026-05-09T15:28Z (mars-32f42ae8 [this one], mars-bd6eed8e, mars-f299ad4f, mars-7d95f15d, mars-f2b4da42, mars-60c1a7f0, mars-508cf4de, mars-5e34d37f, mars-0664fc8b, mars-dbb3e5ff, mars-c3c9c9af, mars-81184da9, mars-3590f087, mars-cd2d41e0, mars-6182abfa, plus more).',
      '',
      'Why the two prescribed options do not fit:',
      "- (a) 'land cleanly into main (rebase + fast-forward)': the branch is already 0 ahead of main; its tip IS main HEAD. There is nothing to fast-forward. `git log main..task/fec8d7af` is empty.",
      "- (b) 'update task row to status=failed with explanation': there is no row to update. queue.db has no entry for fec8d7af; a previous self-heal pass already purged it (backup at .mars/queue.db.bak.selfheal-purge confirms the row was status=failed pre-purge).",
      '',
      'No prior inbox item exists for fec8d7af (state.db inbox_items LIKE %fec8d7af% returned 0 rows), so this is the first inbox raise for this desync chain.',
      '',
      'Suggested resolution paths for whoever picks this up:',
      "- The sweeper desync detector should treat 'branch tip == main HEAD' AND 'no queue.db row exists' as a NO-OP, not a desync. Currently it keeps re-firing on phantom rows that no longer exist.",
      "- Or: the sweeper should join against queue.db tasks before reporting desync, and skip branches whose task row has been purged.",
      "- Same fix would also stop the re-fire pattern on 0b46d264, 0b454825, 0a820a95, ff8c6206, 0451b2bb, 0c76473f, ff08b9a9, ff5710b2, ccb32d6b, etc., which all show the same shape in recent self-heal commits.",
      "- Also worth investigating: why the original reconcile flipped fec8d7af to 'failed' on daemon restart instead of re-checking ancestry against main on resume.",
    ].join('\n'),
    payload: {
      taskId: 'fec8d7af',
      branch: 'task/fec8d7af',
      branchTip: 'd3322b550388da6b7cd8e30959960c27262136d4',
      mainHead: 'd3322b550388da6b7cd8e30959960c27262136d4',
      currentStatus: 'no-row-in-queue',
      pre_purge_status: 'failed',
      pre_purge_error: 'daemon restart while task was running',
      mergedIntoMain: true,
      commitsAhead: 0,
      commitsBehind: 20,
      worktreePath:
        '/Users/ib472e5l/project/perso/mars-framework/.mars/worktrees/fec8d7af',
      queueBackupPath:
        '/Users/ib472e5l/project/perso/mars-framework/.mars/queue.db.bak.selfheal-purge',
      reconcileLogLine:
        '[2026-05-09T08:25:23.350Z] [reconcile] task fec8d7af was running on prior daemon; marking failed',
      originatedAsSelfHealFor: '993649f7',
      selfHealRespawnIds: [
        'mars-32f42ae8',
        'mars-bd6eed8e',
        'mars-f299ad4f',
        'mars-7d95f15d',
        'mars-f2b4da42',
        'mars-60c1a7f0',
        'mars-508cf4de',
        'mars-5e34d37f',
        'mars-0664fc8b',
        'mars-dbb3e5ff',
        'mars-c3c9c9af',
        'mars-81184da9',
        'mars-3590f087',
        'mars-cd2d41e0',
        'mars-6182abfa',
      ],
      selfHealRespawnCount: 16,
    },
    context: {
      taskId: 'fec8d7af',
      branch: 'task/fec8d7af',
      reportedBy: 'self-heal task task/mars-32f42ae8',
    },
    raisedBy: 'self-heal:mars-32f42ae8',
    signature: 'desync-self-heal-ambiguous:fec8d7af',
  })
  process.stdout.write(`raised inbox item ${id}\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`failed: ${(err as Error).message}\n`)
  process.exit(1)
})
