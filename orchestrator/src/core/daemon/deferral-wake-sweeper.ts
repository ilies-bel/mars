import type { Task } from '../queue.js'
import { getBudgetPressureConfig } from '../lib/budget-pressure.js'
import { deleteDeferral, listDeferrals } from '../lib/deferral-store.js'
import { shouldDeferDispatch } from '../lib/dispatch-gate.js'
import { raiseActionQueueItem } from '../lib/action-queue.js'
import type { UsageSnapshotRow } from '../lib/usage-snapshot-store.js'

const DEFERRAL_WAKE_INTERVAL_MS = 30_000

export interface DeferralWakeSweeper {
  tick: () => Promise<void>
  stop: () => void
}

export interface DeferralWakeSweeperOptions {
  /** Poll cadence in milliseconds. Defaults to 30 seconds. */
  interval?: number
  drain: () => void | Promise<void>
  pendingImplement: { add: (taskId: string) => void }
  getLatestSnapshot: () => Promise<UsageSnapshotRow | null>
  getTask: (taskId: string) => Promise<Task | null>
}

/**
 * Re-check persisted dispatch deferrals against the newest usage snapshot.
 *
 * A tick is single-flight: simultaneous timer and startup ticks share the same
 * scan, so a task can be released to the pending set only once per daemon
 * lifetime. The persisted delete keeps a restarted daemon equally idempotent.
 */
export function startDeferralWakeSweeper(
  opts: DeferralWakeSweeperOptions,
): DeferralWakeSweeper {
  let running: Promise<void> | null = null

  const tick = (): Promise<void> => {
    if (running) return running
    running = (async () => {
      const deferrals = await listDeferrals()
      for (const row of deferrals) {
        const [task, snapshot] = await Promise.all([
          opts.getTask(row.taskId),
          opts.getLatestSnapshot(),
        ])
        if (!task) continue

        const decision = shouldDeferDispatch(
          task,
          snapshot,
          getBudgetPressureConfig(),
        )
        if (decision.defer) continue

        await deleteDeferral(row.taskId)
        await raiseActionQueueItem({
          kind: 'scheduling-decision',
          category: 'daemon',
          priority: 'normal',
          title: `Woke deferred task ${row.taskId}`,
          body: row.reason,
          payload: {
            taskId: row.taskId,
            decision: 'woken',
            reason: row.reason,
            pressure: row.pressure,
            targetWindowEnd: row.targetWindowEnd,
            canRunNow: true,
          },
          context: {},
          raisedBy: 'deferral-wake-sweeper',
          signature: `${row.taskId}:woken:${row.targetWindowEnd ?? 'null'}`,
        })
        opts.pendingImplement.add(row.taskId)
        await opts.drain()
      }
    })().finally(() => {
      running = null
    })
    return running
  }

  const interval = setInterval(() => {
    void tick().catch(() => {
      // A later cadence retries transient storage failures without taking down
      // the daemon's timer loop.
    })
  }, opts.interval ?? DEFERRAL_WAKE_INTERVAL_MS)
  interval.unref()

  return {
    tick,
    stop: () => clearInterval(interval),
  }
}
