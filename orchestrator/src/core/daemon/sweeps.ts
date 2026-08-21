import type { EventEmitter } from 'node:events'
import type { TraceEventStore } from '../lib/trace-events-store'
import { updateTask } from '../queue'

/**
 * Everything a periodic sweep is allowed to reach for. Deliberately narrow:
 * a sweep gets the event bus, the daemon log sink, the repo root, the trace
 * store and a snapshot of in-flight task ids — and nothing else from
 * `startDaemon`'s closure. A sweep that needs more than this is not yet a
 * sweep; leave it inline in `server.ts` until its extra dependency has its
 * own seam.
 *
 * There is deliberately no `ViewStreamHub` here: SSE invalidation is derived
 * from `bus` events via `bus/view-invalidation.ts`, so a sweep announces a
 * refresh by emitting a domain event (or a `view.*-invalidated` kind when it
 * has none of its own), never by broadcasting on the hub by hand.
 */
export interface SweepDeps {
  bus: EventEmitter
  log: (line: string) => void
  /** Repo root, read per tick so a context re-resolve is picked up. */
  repoRoot: () => string
  traceStore: TraceEventStore
  /** Task ids currently held by an in-flight dispatch. */
  liveInFlightTaskIds: () => ReadonlySet<string>
}

/**
 * One periodic daemon sweep. `name` doubles as the log prefix, so a throw
 * escaping `run` is reported as `[<name>] errored: …` exactly the way each
 * sweep used to report it from its own inline try/catch.
 */
export interface SweepSpec {
  name: string
  /** Read at `startSweeps` time so env overrides apply per daemon boot. */
  intervalMs: () => number
  run: (deps: SweepDeps) => Promise<void>
}

const STALE_MERGING_THRESHOLD_MS = 40 * 60_000
const STALE_QUEUED_COMMITTER_THRESHOLD_MS = 15 * 60_000
const RUNNING_COMMITTER_LIFETIME_MS = Number(
  process.env.MARS_COMMITTER_LIFETIME_MS ?? 45 * 60_000,
)

/**
 * The daemon's periodic reclamation sweeps, in one list instead of a run of
 * inline `setInterval` blocks in `server.ts`. Each entry is self-describing:
 * cadence, name and body live together, and `startSweeps` is the only thing
 * that knows how to arm one.
 */
export const SWEEPS: readonly SweepSpec[] = [
  {
    // Raises `stale-worktree` action-queue items for tasks whose worktree has
    // not been updated within MARS_STALE_WORKTREE_HOURS (default 24h). The
    // action-queue dedup logic ensures re-detecting the same stale worktree
    // bumps the existing open item rather than creating a sibling. Auto-close
    // is handled by dismissAlertsOnStatusChange (wired in queue.ts updateTask).
    name: 'stale-sweep',
    intervalMs: () => Number(process.env.MARS_STALE_SWEEP_MS ?? 5 * 60_000),
    run: async ({ log, bus, repoRoot }) => {
      const { detectAndRaiseStaleWorktrees } = await import('./stale-worktree-sweep')
      const raised = await detectAndRaiseStaleWorktrees(repoRoot())
      if (raised.length > 0) {
        log(`[stale-sweep] raised/bumped ${raised.length} stale-worktree actionQueue item(s)`)
        bus.emit('view.proposals-invalidated')
        bus.emit('view.action-queue-invalidated')
      }
    },
  },
  {
    // Stale-merge sweep (merging + vega-reconciling).
    //
    // Defense-in-depth: periodically re-queues any task whose status is still
    // 'merging' or 'vega-reconciling' but whose updated_at exceeds the stale
    // threshold. This handles two residual windows:
    //   - 'merging': mergeBranch threw (releasing the lock) but the calling
    //     workflow failed before flipping the task out of 'merging', leaving it
    //     stranded until the next daemon restart.
    //   - 'vega-reconciling': the vcs-supervisor (Vega) subprocess was killed or
    //     crashed without advancing the task status; unlike the boot reconcile
    //     that catches daemon-restart stranding, this sweep catches a live daemon
    //     whose Vega session died mid-conflict-resolution without a restart.
    //
    // The threshold must comfortably exceed the maximum possible in-flight merge
    // duration so the sweep never races a legitimately running merge:
    //   - DEFAULT_WATCHDOG_MS  = VCS_SUPERVISOR_TIMEOUT_MS (default 10 min, env-overridable)
    //                          + MERGE_GIT_BUDGET_MS       ( 5 min)
    //                          = 15 min (default)
    //   + one sweep interval                               = 5 min
    //   → threshold = 40 min
    //
    // IMPORTANT: the sweep identifies stale tasks by age, then passes their ids
    // explicitly to recoverPhase. Without the taskIds filter, recoverPhase would
    // scan ALL tasks in the phase — recovering a legitimately in-progress merge
    // that happens to share the 'merging' status alongside a stale one, which
    // deletes its worktree mid-flight (root cause of task mars-0c5ffe82).
    name: 'stale-merging-sweep',
    intervalMs: () => 5 * 60_000,
    run: async ({ log, bus }) => {
      const { listTasks: listTasksForSweep } = await import('../queue')
      const now = Date.now()
      const mergingTasks = await listTasksForSweep('merging')
      const vegaTasks = await listTasksForSweep('vega-reconciling')
      const staleMerging = mergingTasks.filter(
        (t) => now - new Date(t.updatedAt).getTime() > STALE_MERGING_THRESHOLD_MS,
      )
      const staleVega = vegaTasks.filter(
        (t) => now - new Date(t.updatedAt).getTime() > STALE_MERGING_THRESHOLD_MS,
      )
      if (staleMerging.length === 0 && staleVega.length === 0) return

      const { recoverPhase } = await import('./phase-recovery')
      const { getRepoRoot } = await import('../context')
      const repo = getRepoRoot()

      if (staleMerging.length > 0) {
        const staleIds = staleMerging.map((t) => t.id)
        log(
          `[stale-merging-sweep] found ${staleMerging.length} stale merging task(s) (>40 min); recovering ${staleIds.join(', ')}`,
        )
        const r = await recoverPhase('merging', { log, bus, repoRoot: repo, taskIds: staleIds })
        if (r.requeued.length > 0) {
          log(
            `[stale-merging-sweep] requeued ${r.requeued.length} task(s) from stale merging state`,
          )
          bus.emit('view.tasks-invalidated')
        }
        if (r.finalized > 0) {
          log(
            `[stale-merging-sweep] finalized ${r.finalized} task(s) whose FF already landed`,
          )
          bus.emit('view.tasks-invalidated')
        }
      }

      if (staleVega.length > 0) {
        const staleVegaIds = staleVega.map((t) => t.id)
        log(
          `[stale-merging-sweep] found ${staleVega.length} stale vega-reconciling task(s) (>40 min); recovering ${staleVegaIds.join(', ')}`,
        )
        const rv = await recoverPhase('vega-reconciling', {
          log,
          bus,
          repoRoot: repo,
          taskIds: staleVegaIds,
        })
        if (rv.requeued.length > 0) {
          log(
            `[stale-merging-sweep] requeued ${rv.requeued.length} vega-reconciling task(s) from stale state`,
          )
          bus.emit('view.tasks-invalidated')
        }
        if (rv.finalized > 0) {
          log(
            `[stale-merging-sweep] finalized ${rv.finalized} vega-reconciling task(s) whose FF already landed`,
          )
          bus.emit('view.tasks-invalidated')
        }
      }
    },
  },
  {
    // Stale queued-committer sweep.
    //
    // Re-seeds `main-commiter` fix tasks stuck in `queued` with `blocked`
    // dependents whose `updated_at` exceeds the 15-minute threshold. This
    // mirrors the boot-time `queued-committer-reseed` reconciler and covers the
    // runtime case: the reconciler fires once at boot, but the committer can be
    // spawned long after boot (e.g. when dirty-main is first detected mid-run).
    // Emitting `task.queued` on the bus triggers the handler that pushes the id
    // into `pendingImplement` and calls `drain()`. The primary fix (emitting
    // `task.queued` immediately on spawn in `dispatchImplement`) eliminates the
    // gap for new daemons; this sweep is belt-and-suspenders for any race window
    // or daemon that predates that fix.
    name: 'stale-queued-committer-sweep',
    intervalMs: () => 5 * 60_000,
    run: async ({ log, bus }) => {
      const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE } = await import(
        '../lib/main-dirty'
      )
      const { getDefaultDomainTaskStore: getDomainStore } = await import('../store/task-store')
      const threshold = new Date(Date.now() - STALE_QUEUED_COMMITTER_THRESHOLD_MS).toISOString()
      const r = await getDomainStore().query(
        `SELECT DISTINCT t.id AS id, t.recovery_payload AS recovery_payload
           FROM tasks t
           JOIN task_blockers tb ON tb.blocker_task_id = t.id
           JOIN tasks dep ON dep.id = tb.task_id
          WHERE t.kind = 'fix'
            AND t.status = 'queued'
            AND dep.status = 'blocked'
            AND t.updated_at < ?`,
        [threshold],
      )
      let reseeded = 0
      for (const row of r.rows as unknown as Array<{
        id: string
        recovery_payload: string | null
      }>) {
        if (parseMainCommiterPayload(row.recovery_payload)?.recipe !== MAIN_COMMITER_RECIPE) {
          continue
        }
        bus.emit('task.queued', { taskId: row.id })
        reseeded++
      }
      if (reseeded > 0) {
        log(
          `[stale-queued-committer-sweep] re-seeded ${reseeded} stale queued main-commiter(s) with blocked dependents`,
        )
      }
    },
  },
  {
    // Running-committer lifetime sweep.
    //
    // A main-committer that is still `running` past its bounded lifetime is
    // either stuck (agent can't commit) or working on a branch that has since
    // been cleaned by another means. Two outcomes:
    //
    //   (a) Branch is now clean → settle the committer done immediately
    //       (no further agent action needed) and release blocked dependents.
    //   (b) Branch still dirty → fail the committer with an operator alert so
    //       the queue is never held in `blocked` indefinitely.
    //
    // Default lifetime: 45 minutes. Override via MARS_COMMITTER_LIFETIME_MS.
    name: 'running-committer-sweep',
    intervalMs: () => 5 * 60_000,
    run: async ({ log, bus, repoRoot, traceStore }) => {
      const { parseMainCommiterPayload, MAIN_COMMITER_RECIPE, settleCommitterDoneIfClean } =
        await import('../lib/main-dirty')
      const { getDefaultDomainTaskStore: getDomainStore } = await import('../store/task-store')
      const threshold = new Date(Date.now() - RUNNING_COMMITTER_LIFETIME_MS).toISOString()

      const r = await getDomainStore().query(
        `SELECT DISTINCT t.id AS id, t.recovery_payload AS recovery_payload
           FROM tasks t
           JOIN task_blockers tb ON tb.blocker_task_id = t.id
           JOIN tasks dep ON dep.id = tb.task_id
          WHERE t.kind = 'fix'
            AND t.status = 'running'
            AND dep.status = 'blocked'
            AND t.updated_at < ?`,
        [threshold],
      )

      for (const row of r.rows as unknown as Array<{
        id: string
        recovery_payload: string | null
      }>) {
        const payload = parseMainCommiterPayload(row.recovery_payload)
        if (payload?.recipe !== MAIN_COMMITER_RECIPE) continue

        try {
          const { settled } = await settleCommitterDoneIfClean(
            row.id,
            payload.integrationBranch,
            repoRoot(),
            traceStore,
          )
          const lifetimeMin = Math.round(RUNNING_COMMITTER_LIFETIME_MS / 60_000)
          if (settled) {
            log(
              `[running-committer-sweep] committer ${row.id}: branch '${payload.integrationBranch}' is now clean after ${lifetimeMin}+ min; settled done`,
            )
            bus.emit('task.completed', { taskId: row.id, status: 'done' as const })
          } else {
            // Branch still dirty but committer has exceeded its lifetime.
            // Fail it so the operator can investigate and blocked dependents
            // are eventually released via recovery-spawn or manual intervention.
            log(
              `[running-committer-sweep] committer ${row.id} exceeded ${lifetimeMin}-min lifetime with dirty branch '${payload.integrationBranch}'; failing and raising alert`,
            )
            await updateTask(row.id, {
              status: 'failed',
              failedPhase: 'code',
              failureReason: 'committer:lifetime-exceeded',
              failureReasonCode: 'committer:lifetime-exceeded',
              failureSignature: 'committer:lifetime-exceeded',
              error: `main-committer exceeded ${lifetimeMin}-minute lifetime; integration branch '${payload.integrationBranch}' is still dirty`,
            })
            bus.emit('task.failed', { taskId: row.id, error: 'committer:lifetime-exceeded' })
            try {
              const { raiseActionQueueItem: raiseItem } = await import('../lib/action-queue')
              await raiseItem({
                kind: 'failed',
                category: 'orchestrator',
                priority: 'urgent',
                title: `main-commiter ${row.id} exceeded ${lifetimeMin}-min lifetime; integration branch still dirty`,
                body: `The main-committer for '${payload.integrationBranch}' has been running over ${lifetimeMin} minutes without completing and the branch is still dirty. Manually clean the integration branch or use \`mars continue ${row.id}\` to retry.`,
                payload: {
                  committerTaskId: row.id,
                  integrationBranch: payload.integrationBranch,
                  lifetimeMs: RUNNING_COMMITTER_LIFETIME_MS,
                },
                context: {},
                raisedBy: 'daemon:running-committer-lifetime-sweep',
                signature: `committer:lifetime-exceeded:${row.id}`,
              })
              bus.emit('view.action-queue-invalidated')
            } catch (alertErr) {
              log(
                `[running-committer-sweep] alert raise for ${row.id} failed (non-fatal): ${(alertErr as Error).message}`,
              )
            }
          }
        } catch (sweepErr) {
          log(
            `[running-committer-sweep] check for committer ${row.id} failed (non-fatal): ${(sweepErr as Error).message}`,
          )
        }
      }
    },
  },
  {
    // Orphan-subprocess sweep.
    //
    // Verify/test runners that outlive their task (abort, timeout, or a daemon
    // that died before it could kill the group) get reparented to init and burn
    // CPU indefinitely. The Steward reaps them on its own schedule here, in
    // addition to the boot sweep and the sweep on the autotuner's hold path.
    name: 'orphan-reaper',
    intervalMs: () => Number(process.env.MARS_ORPHAN_SWEEP_MS ?? 5 * 60_000),
    run: async ({ log, repoRoot, liveInFlightTaskIds }) => {
      const { sweepOrphans, formatSweepSummary } = await import('../lib/orphan-reaper')
      const summary = await sweepOrphans({
        repoRoot: repoRoot(),
        inFlightTaskIds: liveInFlightTaskIds(),
        log,
      })
      if (summary.reaped > 0) {
        log(`[orphan-reaper] periodic sweep: ${formatSweepSummary(summary)}`)
      }
    },
  },
]

export interface SweepsHandle {
  /** Clears every sweep interval. Called from the daemon's shutdown path. */
  stop: () => void
}

/**
 * Arms every entry in {@link SWEEPS}. Each gets its own `setInterval`, is
 * `.unref()`ed so it can never hold the process open, and has its rejections
 * funnelled into the daemon log under the sweep's own name — a sweep body may
 * therefore throw freely without taking the daemon down.
 */
export const startSweeps = (deps: SweepDeps): SweepsHandle => {
  const handles = SWEEPS.map((spec) => {
    const handle = setInterval(() => {
      void spec.run(deps).catch((err: unknown) => {
        deps.log(`[${spec.name}] errored: ${(err as Error).message}`)
      })
    }, spec.intervalMs())
    handle.unref()
    return handle
  })
  return {
    stop: () => {
      for (const handle of handles) clearInterval(handle)
    },
  }
}
