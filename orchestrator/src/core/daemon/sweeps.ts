import type { EventEmitter } from 'node:events'
import { getStateDir, resolveDbTarget } from '../context'
import { listTasks, updateTask } from '../queue'
import { recycleDbPool } from '../lib/db'
import { EVENT_RETENTION, pruneEvents } from '../../bus/retention'
import { getDefaultDomainTaskStore } from '../store/task-store'
import type { TraceEventStore } from '../lib/trace-events-store'
import type { TaskFlightTracker } from './task-flight-tracker'
import type { DaemonSemaphores } from './scheduler'
import type { PauseController } from './pause-state'
import { resolveIntegrationBranch, resolveSweepIntervalsMs } from '../config/daemon-intervals'
import { UPDATE_POLL_INTERVAL_MS, pollGithubRelease } from './github-update-poller'
import { loadDaemonConfig } from './config'

/**
 * Everything a periodic sweep is allowed to reach for. Started deliberately
 * narrow (bus, log, repo root, trace store, in-flight task ids); widened
 * since, one dependency at a time, only as far as an actual sweep needed —
 * see the git history of this file for the incremental additions below. A
 * sweep that needs something not yet here is still not a sweep; leave it
 * inline in `server.ts` until its extra dependency earns its own field.
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
  /** The daemon's dispatch-flight bookkeeping (in-flight snapshot, force-release, pending counts). */
  tracker: TaskFlightTracker
  /** Per-kind concurrency semaphores (read-only from a sweep's point of view). */
  sems: DaemonSemaphores
  /** The daemon's one authoritative dispatch-pause controller. */
  pause: PauseController
  /** Triggers a dispatch drain after a sweep frees a slot or requeues work. */
  drain: () => Promise<void>
  /** Task ids actively running through the verify phase in this daemon instance. */
  activeVerifyingTaskIds: () => ReadonlySet<string>
  /** Timestamp dispatch last resumed from a pause (undefined if never paused). */
  dispatchResumedAt: () => number | undefined
  /** True while the baseline health checker considers the integration branch poisoned. */
  isBaselinePoisoned: () => boolean
  /** Fires the DB busy-storm watchdog's final escalation stage: a graceful daemon self-restart. */
  triggerDbRestart: () => void
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
  /**
   * When true, `startSweeps` also runs this sweep once immediately (before
   * arming its interval) so a freshly started daemon doesn't wait a full
   * interval before its first pass — matches the pre-extraction inline
   * blocks that called their body once at startup and then again per tick.
   */
  runOnStart?: boolean
}

const STALE_MERGING_THRESHOLD_MS = 40 * 60_000
const STALE_QUEUED_COMMITTER_THRESHOLD_MS = 15 * 60_000
/** Cadences for the sweeps below — see `../config/daemon-intervals.ts`. */
const SWEEP_INTERVALS_MS = resolveSweepIntervalsMs()
const RUNNING_COMMITTER_LIFETIME_MS = SWEEP_INTERVALS_MS.committerLifetime

// Escalation stage carried between db-busy-watchdog ticks (null = no storm in
// progress). Module-scoped rather than SweepDeps-carried: it is this sweep's
// own private state, not something any other sweep or the daemon reads.
let dbBusyStage: import('./db-busy-watchdog').BusyEscalationStage | null = null

// Wall-clock the implement queue first crossed the backlog threshold, or null
// when not currently backlogged. Same rationale as dbBusyStage above.
let backlogSince: number | null = null

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
    intervalMs: () => SWEEP_INTERVALS_MS.staleSweep,
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
    intervalMs: () => SWEEP_INTERVALS_MS.orphanSweep,
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
  {
    // Observability store size watchdog. Checks the trace_events footprint
    // inside mars.db; when it exceeds 500 MB a single open action-queue item
    // is raised (re-detection bumps the existing item rather than spawning a
    // sibling). NEVER prunes the store or alters retention — see
    // retention-sweep below for that.
    name: 'observability-watchdog',
    intervalMs: () => SWEEP_INTERVALS_MS.observabilityWatchdog,
    run: async ({ log, bus }) => {
      const { checkObservabilityStoreSize } = await import('./observability-watchdog')
      const itemId = await checkObservabilityStoreSize(resolveDbTarget())
      if (itemId) {
        log(`[observability-watchdog] store oversize — raised/bumped action-queue item ${itemId}`)
        bus.emit('view.action-queue-invalidated')
      }
    },
  },
  {
    // DB busy-storm watchdog. Escalates across successive ticks: log loudly →
    // recycle the connection pool → trigger a graceful daemon self-restart.
    // See db-busy-watchdog.ts for the full stage rationale; disable the final
    // restart stage via MARS_DB_BUSY_STORM_RESTART=false.
    name: 'db-busy-watchdog',
    intervalMs: () => SWEEP_INTERVALS_MS.dbBusyWatchdog,
    run: async ({ log, triggerDbRestart }) => {
      const { checkAndEscalateDbBusyStorm } = await import('./db-busy-watchdog')
      const result = await checkAndEscalateDbBusyStorm(
        resolveDbTarget(),
        log,
        recycleDbPool,
        triggerDbRestart,
        dbBusyStage,
      )
      dbBusyStage = result.nextStage
    },
  },
  {
    // Outbox sweeper. Prunes aged events from the outbox and raises a
    // dedup'd action-queue item for any subscriber whose cursor lag exceeds
    // MARS_OUTBOX_LAG_WARN_THRESHOLD.
    name: 'outbox-sweep',
    intervalMs: () => SWEEP_INTERVALS_MS.outboxPrune,
    run: async () => {
      const { sweepOutbox } = await import('./outbox-sweeper')
      await sweepOutbox(resolveDbTarget())
    },
  },
  {
    // History retention sweeper. Applies EVENT_RETENTION — the single
    // retention policy for orchestrator history — to trace_events, events and
    // task_transcripts so the state store stays bounded across multi-day
    // sessions. Always logs the gauges so drift is visible in watch.log
    // rather than silent until a deletion threshold is crossed.
    name: 'retention-sweep',
    intervalMs: () => SWEEP_INTERVALS_MS.observabilitySweep,
    run: async ({ log }) => {
      const retention = await pruneEvents(resolveDbTarget())
      const deleted =
        retention.traceEventsByAge +
        retention.traceEventsByCount +
        retention.eventsByAge +
        retention.eventsByCount +
        retention.transcriptsByAge +
        retention.subscriberProcessedEventsOrphans
      log(
        `[retention-sweep] cap ${EVENT_RETENTION.maxRows} rows /` +
          ` ${EVENT_RETENTION.days} days; deleted ${deleted};` +
          ` trace_events: ${retention.traceEventsRemaining} rows` +
          ` (${retention.traceEventsByAge} by age,` +
          ` ${retention.traceEventsByCount} by count);` +
          ` events: ${retention.eventsRemaining} rows` +
          ` (${retention.eventsByAge} by age,` +
          ` ${retention.eventsByCount} by count);` +
          ` ${retention.transcriptsByAge} task_transcripts;` +
          ` ${retention.subscriberProcessedEventsOrphans} subscriber_processed_events orphans`,
      )
    },
  },
  {
    // KPI snapshot sweep. Takes a rolling 7-day KPI snapshot once per
    // interval and persists a row to kpi_snapshots so the /kpis route and UI
    // tiles always have data. Runs once at startup too so a freshly started
    // daemon shows data without waiting a full interval.
    name: 'kpi-snapshot',
    intervalMs: () => SWEEP_INTERVALS_MS.kpiSnapshot,
    runOnStart: true,
    run: async ({ log }) => {
      const { takeKpiSnapshot } = await import('../lib/kpi-snapshots.js')
      await takeKpiSnapshot({
        surface: getDefaultDomainTaskStore(),
        now: new Date().toISOString(),
      })
      log('[kpi-snapshot] snapshot taken')
    },
  },
  {
    // Observational Notice sweep. The proactive half of the main thread:
    // nothing here reacts to an event, so nothing else would ever run it.
    // Deliberately infrequent — every Notice it can produce describes a
    // *trend* or a *habit*, and neither changes between one hour and the
    // next. Delivery still waits for a pause, so a sweep landing mid-grill
    // queues rather than interrupts. Runs once at startup so a fresh session
    // opens on something to do rather than on an empty feed.
    name: 'notice-sweep',
    intervalMs: () => SWEEP_INTERVALS_MS.noticeSweep,
    runOnStart: true,
    run: async ({ log, bus, repoRoot }) => {
      const { runNoticeSweep } = await import('../lib/notices/sweep.js')
      const { resolveStateClient: stateClient } = await import('../store/state-client.js')
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const root = repoRoot()
      const integrationBranch = resolveIntegrationBranch()
      const result = await runNoticeSweep({
        client: stateClient(),
        repoRoot: root,
        integrationBranch,
        log,
        listCommits: async (branch, sinceMs) => {
          const { stdout } = await promisify(execFile)(
            'git',
            ['log', branch, '--format=%H', `--since=${new Date(sinceMs).toISOString()}`],
            { cwd: root },
          )
          return stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        },
        listCommitRange: async (from, to) => {
          const { stdout } = await promisify(execFile)(
            'git',
            ['rev-list', `${from}..${to}`],
            { cwd: root },
          )
          return stdout.trim().split('\n').filter(Boolean)
        },
      })
      if (result.posted > 0) {
        log(`[notice-sweep] spoke ${result.posted} Notice(s)`)
        bus.emit('view.chat-invalidated')
      }
    },
  },
  {
    // Steward runtime-knob backlog check. When the implement queue is
    // backlogged (pending > cap × 0.75) for a sustained window (default
    // 60s), emits kpi.backlog.degraded so the steward subscriber — wired
    // separately in server.ts via startStewardRuntimeTune — bumps the cap
    // autonomously.
    name: 'backlog-check',
    intervalMs: () => SWEEP_INTERVALS_MS.backlogCheck,
    run: async ({ bus, tracker, sems }) => {
      const BACKLOG_SUSTAIN_MS = SWEEP_INTERVALS_MS.backlogSustain
      const pending = tracker.pendingCount('implement')
      const threshold = Math.floor(sems.implement.limit * 0.75)
      if (pending > threshold) {
        if (backlogSince === null) backlogSince = Date.now()
        const elapsed = Date.now() - backlogSince
        if (elapsed >= BACKLOG_SUSTAIN_MS) {
          bus.emit('kpi.backlog.degraded', {
            pending,
            cap: sems.implement.limit,
            sustainedMs: elapsed,
          })
          backlogSince = null
        }
      } else {
        backlogSince = null
      }
    },
  },
  {
    // Reflect-recommended detector sweep. Periodically evaluates
    // reflect-worthiness (KPI drift, failure clusters, token spikes) and
    // raises / clears the level-triggered reflect-recommended action-queue
    // row. When selfEvolve.autoRunReflect is 'on', runs the reflection
    // pipeline immediately instead of waiting for an operator action.
    name: 'reflect-detector',
    intervalMs: () => SWEEP_INTERVALS_MS.reflectDetector,
    run: async ({ log, bus, pause, isBaselinePoisoned }) => {
      const { runReflectRecommendedDetector } = await import('../lib/self-evolve-trigger')
      const result = await runReflectRecommendedDetector()
      if (result.raised) {
        log(`[reflect-detector] raised reflect-recommended row (row=${result.rowId})`)
        bus.emit('view.action-queue-invalidated')
        // When auto-run-reflect is on, immediately run the reflection pipeline
        // instead of waiting for an operator action on the row.
        const { loadDaemonConfig: getLatestCfg } = await import('./config')
        if (getLatestCfg().controlLevers.autoRunReflect === 'on') {
          log('[reflect-detector] auto-run-reflect=on — running reflection automatically')
          try {
            const { loadRecentTaskCorpus } = await import('../lib/reflect-query')
            const { persistSuggestions } = await import('../lib/reflector')
            const { requireReflector } = await import('../ports/reflector/registry')
            const { closeReflectRecommendedRow: closeRow } = await import(
              '../lib/self-evolve-trigger'
            )
            const { insertReflectionTask } = await import('../queue')
            const { persistLastReflectRanAt } = await import('./config')
            // Same baseline-attribution source as runReflect and
            // getConditionsSource's action-queue derivation.
            const corpus = await loadRecentTaskCorpus({
              limit: 10,
              isBaselinePoisoned,
              getPauseState: () => pause.get(),
            })
            let proposalsRaised = 0
            if (corpus.entries.length > 0) {
              const reflResult = await requireReflector<
                import('../lib/reflector').TokenReflectorPortRequest,
                import('../lib/reflector').ReflectionResult
              >('token').reflect(corpus)
              if (reflResult.suggestions.length > 0) {
                const sourceTaskId = await insertReflectionTask(corpus.entries.length)
                await persistSuggestions(reflResult.suggestions, sourceTaskId)
                proposalsRaised = reflResult.suggestions.length
                bus.emit('view.proposals-invalidated')
                bus.emit('view.action-queue-invalidated')
              }
            }
            await closeRow()
            persistLastReflectRanAt(new Date().toISOString())
            bus.emit('view.action-queue-invalidated')
            log(`[reflect-detector] auto-reflect completed (proposals=${proposalsRaised})`)
          } catch (reflectErr) {
            log(`[reflect-detector] auto-reflect errored: ${(reflectErr as Error).message}`)
          }
        }
      } else {
        log(
          '[reflect-detector] no signals: kpiDrift=0 failureClusters=0 tokenSpike=null; reflection not yet needed',
        )
      }
    },
  },
  {
    // Stale-queued watchdog. Scans for tasks sitting in 'queued' past
    // MARS_STALE_QUEUED_MS (default 10 min) and raises a 'stale-queued'
    // action-queue alert for each one, so the operator can tell whether the
    // pool is saturated or the dispatcher is stuck. Shares the phantom-task
    // watchdog's cadence (MARS_PHANTOM_WATCHDOG_MS).
    name: 'stale-queued-watchdog',
    intervalMs: () => SWEEP_INTERVALS_MS.phantomWatchdog,
    run: async ({ log, bus, tracker, sems, pause, dispatchResumedAt }) => {
      const { runStaleQueuedSweep } = await import('./stale-queued-watchdog')
      const activeWorkerCount = tracker.inFlightCount()
      const queuedTasks = await listTasks('queued')
      const queueDepth = queuedTasks.length
      const { alerted } = await runStaleQueuedSweep({
        activeWorkerCount,
        implementCap: sems.implement.limit,
        queueDepth,
        dispatchDecisionSummary: [],
        dispatchPauseState: pause.get(),
        dispatchResumedAt: dispatchResumedAt(),
      })
      if (alerted.length > 0) {
        log(
          `[stale-queued-watchdog] raised alert for ${alerted.length} stale-queued task(s): ${alerted.join(', ')}`,
        )
        bus.emit('view.action-queue-invalidated')
      }
    },
  },
  {
    // Awaiting-validation watchdog. Reuses the stale-queued / phantom
    // cadence: preview-gated tasks are parked deliberately, but a dead
    // preview must be demoted immediately and expires after 48h so it cannot
    // pollute the operator queue forever.
    name: 'awaiting-validation-watchdog',
    intervalMs: () => SWEEP_INTERVALS_MS.phantomWatchdog,
    run: async ({ log, bus }) => {
      const { runAwaitingValidationSweep } = await import('./awaiting-validation-watchdog')
      const { demoted, failed } = await runAwaitingValidationSweep()
      if (demoted.length > 0 || failed.length > 0) {
        log(
          `[awaiting-validation-watchdog] demoted ${demoted.length} dead preview(s); expired ${failed.length} task(s)`,
        )
        bus.emit('view.action-queue-invalidated')
        bus.emit('view.tasks-invalidated')
      }
    },
  },
  {
    // Phantom-task watchdog. Sweeps for tasks stuck in 'running' or
    // 'verifying' with no live subprocess, preventing a dead worker from
    // holding an in-flight slot indefinitely (root cause of the
    // mars-f35b1c7f 12-hour freeze). See phantom-task-watchdog.ts for the
    // dead-PID / wall-clock-ceiling detection detail. Phantom kills do NOT
    // spawn a recovery task — the operator receives an action-queue item and
    // restarts or drops the task explicitly.
    name: 'phantom-watchdog',
    intervalMs: () => SWEEP_INTERVALS_MS.phantomWatchdog,
    run: async ({ log, bus, tracker, drain, activeVerifyingTaskIds }) => {
      const { sweepPhantomTasks } = await import('./phantom-task-watchdog')
      const { getDefaultMergeJobStore } = await import('../store/merge-job-store')
      const { failed, requeued } = await sweepPhantomTasks(
        tracker.inFlightSnapshot(),
        (id, _kind) => {
          // Mirror handleDrop(force=true): force-clear ONLY the tracker entry
          // and let drain() reclaim the slot once the dispatcher's own
          // release closure runs — see the original inline comment history
          // for why double-releasing the semaphore here would silently
          // defeat the implement cap.
          tracker.forceRelease(id)
          void drain()
        },
        undefined,
        undefined,
        (taskId) => getDefaultMergeJobStore().getActiveMergeJob(taskId).then((j) => j !== null),
        (taskId) => activeVerifyingTaskIds().has(taskId),
      )
      if (failed.length > 0) {
        log(
          `[phantom-watchdog] auto-failed ${failed.length} phantom in-flight task(s): ${failed.join(', ')}`,
        )
        bus.emit('view.action-queue-invalidated')
        bus.emit('view.tasks-invalidated')
        void drain()
      }
      if (requeued.length > 0) {
        log(
          `[phantom-watchdog] re-queued ${requeued.length} orphaned running task(s) with no in-flight entry: ${requeued.join(', ')}`,
        )
        for (const taskId of requeued) {
          bus.emit('task.queued', { taskId })
        }
        void drain()
      }
    },
  },
  {
    // GitHub release update poller. Fetches the repo's latest release once on
    // startup (`runOnStart`) and every UPDATE_POLL_INTERVAL_MS (6 h) after
    // that, writing the result to `.mars/update.json`. On any failure it
    // leaves the cache untouched and logs at debug level, so a rate-limited or
    // offline daemon degrades to a stale cache rather than a noisy one.
    name: 'github-update-poller',
    intervalMs: () => UPDATE_POLL_INTERVAL_MS,
    runOnStart: true,
    run: async ({ log }) => {
      await pollGithubRelease(getStateDir(), { debug: (msg) => log(msg) })
    },
  },
  {
    // Draft-proposal reconcile sweep. Raises a `draft-proposal` action-queue
    // row for every proposal in status='draft' that has NO action_queue_items
    // row of any status. This is the safety net for the single missed-event
    // failure mode: if the `action-queue-repopulator` subscriber is not draining
    // when `proposal.added` fires (daemon down, crash, outbox drop), the row is
    // never created and nothing backfills it without this sweep.
    //
    // Idempotent by construction: the NOT EXISTS predicate finds only proposals
    // with no row at all — a draft whose row is already open or resolved is
    // skipped. `raiseActionQueueItem` additionally deduplicates via the
    // origin-keyed fingerprint as belt-and-suspenders.
    //
    // Runs once at startup so a freshly started daemon heals any proposals that
    // missed their row while it was down, and every hour afterward so a
    // long-lived daemon does not accumulate silent orphans.
    name: 'draft-proposal-reconcile',
    intervalMs: () => 60 * 60 * 1000,
    runOnStart: true,
    run: async ({ log, bus }) => {
      const { raised } = await reconcileDraftProposalRows()
      if (raised > 0) {
        log(
          `[draft-proposal-reconcile] raised ${raised} missing draft-proposal action-queue row(s)`,
        )
        bus.emit('view.action-queue-invalidated')
      }
    },
  },
  {
    // Daily proposal expiry sweep. The startup reconciler already expires
    // stale agent-authored drafts on boot; this keeps the sweep running daily
    // so a long-lived daemon does not accumulate new stale rows between
    // restarts. Each expired draft also supersedes any action-queue item that
    // pointed at it, so the queue never offers a row whose proposal is gone.
    name: 'proposal-expiry',
    intervalMs: () => 24 * 60 * 60 * 1000,
    run: async ({ log }) => {
      const { expireProposals } = await import('../proposals')
      const { supersedeActionQueueItemsForOrigin } = await import('../lib/action-queue')
      const expiryMs = loadDaemonConfig().proposalExpiryDays * 24 * 60 * 60 * 1000
      const { count, ids } = await expireProposals(expiryMs)
      if (count === 0) return
      log(`[proposal-expiry] expired ${count} stale auto-generated draft(s)`)
      for (const id of ids) {
        await supersedeActionQueueItemsForOrigin(
          id,
          'origin-dropped',
          'proposal-expiry-sweep',
        ).catch(() => {
          // Non-fatal: a superseded-row write failure must not abort the sweep
          // and strand the remaining expired ids.
        })
      }
    },
  },
  {
    // Lever-gate catalogue sweep. Reconciles the lever registry's `verifyGate`
    // recipes against the set of already-registered verify gates and raises a
    // `verify-uncovered` action-queue item for each (scope, name) pair that is
    // not yet covered.
    //
    // DEC-17 position — permissible under the "it idles" clause: this sweep is
    // DB-only. It reads the lever registry (in-memory) and the gate table
    // (DB read), raises operator-decision rows (DB write), spawns no Worker,
    // and makes no LLM call. A future audit should not need to re-derive this.
    //
    // Low-frequency (hourly, MARS_LEVER_GATE_SWEEP_MS override) because the
    // registry is static and the gate set changes rarely. `runOnStart: true`
    // so a repo initialised before this shipped gets its proposals on the next
    // daemon boot rather than waiting a full hour.
    //
    // proposeGatesFromLevers is idempotent by construction — it skips
    // already-registered and already-open (scope, name) pairs — so running it
    // repeatedly converges safely. This satisfies VISION.md DEC-11's
    // "gates are earned by observation" PRD 6bbf9f4c slice 8 outcome:
    // lever recipes that carry a `verifyGate` spec automatically raise
    // verify-uncovered items for scopes where the gate is not yet registered.
    name: 'lever-gate-sweep',
    intervalMs: () => SWEEP_INTERVALS_MS.leverGateSweep,
    runOnStart: true,
    run: async ({ log, bus }) => {
      const { proposeGatesFromLevers } = await import('../lib/propose-gates-from-levers.js')
      const result = await proposeGatesFromLevers()
      if (result.proposed > 0) {
        log(
          `[lever-gate-sweep] proposed ${result.proposed} verify-uncovered gate proposal(s) (skipped ${result.skipped})`,
        )
        bus.emit('view.action-queue-invalidated')
      }
    },
  },
]

/**
 * Raise a `draft-proposal` action-queue row for every proposal in
 * status=`'draft'` that currently has NO `action_queue_items` row of any
 * status keyed to its id.
 *
 * This is the idempotent safety net for the single missed-event failure mode:
 * if the `action-queue-repopulator` subscriber is not draining when
 * `proposal.added` fires (daemon down, crash, outbox drop), no row is created
 * and nothing ever backfills it. Running this at startup and periodically
 * closes that gap permanently.
 *
 * - Drafts with an existing open row → `raiseActionQueueItem` bumps
 *   `seen_count` (NOT EXISTS prevents even reaching this path, but
 *   `raiseActionQueueItem` is idempotent as belt-and-suspenders).
 * - Drafts with a resolved row → NOT selected by the NOT EXISTS predicate,
 *   so they are never touched.
 * - Running twice → second pass finds no proposals that pass NOT EXISTS
 *   (rows were raised by the first pass), so `raised = 0`.
 *
 * @returns The number of action-queue rows raised by this pass.
 */
export async function reconcileDraftProposalRows(): Promise<{ raised: number }> {
  const { getDefaultDomainTaskStore } = await import('../store/task-store')
  const { raiseDraftProposalRow } = await import('./action-queue-repopulator')

  const store = getDefaultDomainTaskStore()
  const result = await store.query({
    sql: `SELECT p.id, p.title, p.source
            FROM proposals p
           WHERE p.status = 'draft'
             AND NOT EXISTS (
               SELECT 1
                 FROM action_queue_items a
                WHERE a.origin_task_id = p.id
             )`,
  })

  let raised = 0
  for (const raw of result.rows) {
    const row = raw as unknown as { id: string; title: string; source: string }
    await raiseDraftProposalRow({
      proposalId: row.id,
      title: row.title,
      source: row.source,
      raisedBy: 'sweep:draft-proposal-reconcile',
    })
    raised++
  }

  return { raised }
}

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
    const tick = () => {
      void spec.run(deps).catch((err: unknown) => {
        deps.log(`[${spec.name}] errored: ${(err as Error).message}`)
      })
    }
    if (spec.runOnStart) tick()
    const handle = setInterval(tick, spec.intervalMs())
    handle.unref()
    return handle
  })
  return {
    stop: () => {
      for (const handle of handles) clearInterval(handle)
    },
  }
}
