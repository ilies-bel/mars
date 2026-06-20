/**
 * One-shot: resolve the 7 stale, un-auto-dismissable action_queue_items rows
 * in the gustave repo's .mars/mars.db. These are signature-keyed `failed` /
 * `diagnose-inconclusive` alerts (no origin_task_id, no payload.taskId) and
 * `phantom-task` rows whose underlying task was merged-and-purged outside the
 * orchestrator — so no task lifecycle event will ever close them.
 *
 * Run via:
 *   MARS_REPO=/Users/ib472e5l/project/perso/gustave \
 *     node_modules/.bin/tsx scripts/cleanup-stale-gustave-rows.mts
 *
 * Goes through setActionQueueState (NOT a raw UPDATE) so each close lands a
 * matching action_queue_history row. Idempotent: closed rows are skipped by
 * the WHERE state='open' guard inside the resolver chain.
 */
import { setActionQueueState } from '../src/core/lib/action-queue.ts'

const ROWS: Array<{ id: string; note: string }> = [
  { id: 'fb5efb80', note: 'stale: diagnose-inconclusive, signature-keyed (no origin/task linkage); blocked on pre-existing cascade tracked elsewhere' },
  { id: '62d4908e', note: 'stale: verify hang fix complete, signature-keyed alert with no task linkage; cannot auto-dismiss' },
  { id: '310648c1', note: 'stale: infra alert (embedded-pg cache wiped by parallel reap); transient, no owning task' },
  { id: '53e8bc01', note: 'stale: fix work merged to main, task fix-037bec3a purged outside orchestrator; no terminal event possible' },
  { id: '3fb11de7', note: 'stale: AuthWiringDefaults fix committed and scoped tests green; full-suite flakiness alert, no task linkage' },
  { id: '59ac4c1d', note: 'stale: phantom recovery, mars-4680bf9d already manually merged into main; task absent' },
  { id: '9ff3f734', note: 'stale: phantom recovery fix-7954a330 manually merged as 10734a54; worktree/task absent' },
]

const by = 'operator:one-time-stale-sweep'
let closed = 0
for (const { id, note } of ROWS) {
  await setActionQueueState(id, 'resolved', {
    resolution: 'superseded',
    note,
    by,
  })
  console.log(`resolved ${id} — ${note}`)
  closed++
}
console.log(`\nDone: requested ${ROWS.length}, processed ${closed}.`)
