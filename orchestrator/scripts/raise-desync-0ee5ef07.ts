import { raiseInboxItem } from '../src/mastra/lib/inbox'

const main = async (): Promise<void> => {
  const id = await raiseInboxItem({
    kind: 'desync-self-heal-ambiguous',
    category: 'daemon',
    priority: 'high',
    title:
      'Desync self-heal for 0ee5ef07: branch already landed, queue row already purged, neither (a) nor (b) fits',
    body: [
      'Self-heal task for 0ee5ef07 cannot be resolved by either of the two prompt-prescribed paths.',
      '',
      'Findings (worktree task/mars-7e0cfdfd, main=7a626df):',
      '- task/0ee5ef07 tip = d3322b5 ("feat(orchestrator): write per-scope AGENTS.md from mars init"). This is the same merged commit that task/fec8d7af landed at — both branches are aliases pointing at the same already-merged tip.',
      '- git rev-list --left-right --count main...task/0ee5ef07 = 24  0  → branch is strictly an ancestor of main (0 ahead, 24 behind).',
      '- git merge-base --is-ancestor task/0ee5ef07 main → YES.',
      '- queue.db (current) has NO row for 0ee5ef07. The row was purged in a prior self-heal cleanup. queue.db.bak.selfheal-purge still has it: id=0ee5ef07, status=failed, branch=task/0ee5ef07, error="daemon restart while task was running".',
      '- watch.log: "[2026-05-09T07:35:06.881Z] [implement] 0ee5ef07 dispatching" then "[2026-05-09T08:25:23.347Z] [reconcile] task 0ee5ef07 was running on prior daemon; marking failed". Same reconcile pathology as fec8d7af: the row was conservatively flipped to failed on daemon restart even though the branch later landed.',
      '- 0ee5ef07 was itself enqueued by the sweeper as a self-heal for task/276089ce ("[2026-05-09T07:35:06.877Z] [sweeper] desync task/276089ce (mars=failed, merged=true); enqueued self-heal task 0ee5ef07"), so this is a self-heal for a self-heal — same shape as fec8d7af (which self-healed 993649f7).',
      '- sweeper.log shows 15 re-fires for 0ee5ef07 between 2026-05-09T12:47Z and 2026-05-09T15:26Z (mars-eb884676, mars-7e0cfdfd [this one], mars-fbb4e5a3, mars-3f7c468f, mars-39e19691, mars-aefbc5d3, mars-485f95fc, mars-a41044ab, mars-ab2d357b, mars-43ac608e, mars-d6f85ac0, mars-6ea6b770, mars-cfb30e91, mars-2e53d0c4, mars-d19361c3).',
      '',
      'Why the two prescribed options do not fit:',
      "- (a) 'land cleanly into main (rebase + fast-forward)': the branch is 0 ahead of main; its tip is already an ancestor of main HEAD. There is nothing to fast-forward. `git log main..task/0ee5ef07` is empty.",
      "- (b) 'update task row to status=failed with explanation': there is no row to update. queue.db has no entry for 0ee5ef07; a previous self-heal pass already purged it (backup at .mars/queue.db.bak.selfheal-purge confirms the row was status=failed pre-purge, error='daemon restart while task was running').",
      '',
      'No prior inbox item exists for 0ee5ef07 (state.db inbox_items signature/title/fingerprint searches all returned 0 rows), so this is the first inbox raise for this desync chain.',
      '',
      'This is the second raised inbox of this exact shape today (after fec8d7af → inbox decb6261), and both branches share the same merged tip d3322b5. The shared root cause is the daemon-restart reconcile path flipping running tasks to failed without ancestry rechecking, plus the sweeper continuing to fire on phantom rows that have already been purged.',
      '',
      'Suggested resolution paths for whoever picks this up:',
      "- The sweeper desync detector should treat 'branch tip is ancestor of main HEAD' AND 'no queue.db row exists' as a NO-OP, not a desync. Currently it keeps re-firing on phantom rows that no longer exist.",
      "- Or: the sweeper should join against queue.db tasks before reporting desync, and skip branches whose task row has been purged.",
      "- Same fix would also stop the re-fire pattern on fec8d7af, 0b46d264, 0b454825, 0a820a95, ff8c6206, 0451b2bb, 0c76473f, ff08b9a9, ff5710b2, ccb32d6b, etc., all visible in recent self-heal commits with the same shape.",
      "- Also worth investigating: why the original reconcile flipped 0ee5ef07 (and fec8d7af) to 'failed' on daemon restart instead of re-checking ancestry against main on resume — that initial mis-classification is the upstream cause of every subsequent self-heal cascade.",
    ].join('\n'),
    payload: {
      taskId: '0ee5ef07',
      branch: 'task/0ee5ef07',
      branchTip: 'd3322b550388da6b7cd8e30959960c27262136d4',
      mainHead: '7a626dbf5a1c92710818da717fae92f984440450',
      currentStatus: 'no-row-in-queue',
      pre_purge_status: 'failed',
      pre_purge_error: 'daemon restart while task was running',
      mergedIntoMain: true,
      commitsAhead: 0,
      commitsBehind: 24,
      worktreePath:
        '/Users/ib472e5l/project/perso/mars-framework/.mars/worktrees/0ee5ef07',
      queueBackupPath:
        '/Users/ib472e5l/project/perso/mars-framework/.mars/queue.db.bak.selfheal-purge',
      reconcileLogLine:
        '[2026-05-09T08:25:23.347Z] [reconcile] task 0ee5ef07 was running on prior daemon; marking failed',
      originatedAsSelfHealFor: '276089ce',
      sharedTipWith: 'fec8d7af',
      relatedInboxItem: 'decb6261',
      selfHealRespawnIds: [
        'mars-eb884676',
        'mars-7e0cfdfd',
        'mars-fbb4e5a3',
        'mars-3f7c468f',
        'mars-39e19691',
        'mars-aefbc5d3',
        'mars-485f95fc',
        'mars-a41044ab',
        'mars-ab2d357b',
        'mars-43ac608e',
        'mars-d6f85ac0',
        'mars-6ea6b770',
        'mars-cfb30e91',
        'mars-2e53d0c4',
        'mars-d19361c3',
      ],
      selfHealRespawnCount: 15,
    },
    context: {
      taskId: '0ee5ef07',
      branch: 'task/0ee5ef07',
      reportedBy: 'self-heal task task/mars-7e0cfdfd',
    },
    raisedBy: 'self-heal:mars-7e0cfdfd',
    signature: 'desync-self-heal-ambiguous:0ee5ef07',
  })
  process.stdout.write(`raised inbox item ${id}\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`failed: ${(err as Error).message}\n`)
  process.exit(1)
})
