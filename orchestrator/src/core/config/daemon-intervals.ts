/**
 * The env reads behind the daemon's periodic drains/sweeps/scheduler timers.
 *
 * `drains.ts`, `sweeps.ts` and `scheduler.ts` each declare a list of
 * `setInterval`-driven jobs whose cadence is `MARS_*_MS`-overridable. Before
 * this module those three files read `process.env` directly, one call per
 * knob — harmless individually, but exactly the sprawl
 * `orchestrator/src/core/config/` exists to prevent (see the `env-reads` arch
 * guard: "the one place allowed to read it; everywhere else receives config
 * as a value"). This module is that one place for these three files' knobs;
 * `resolveDrainIntervalsMs` / `resolveSchedulerIntervalsMs` /
 * `resolveSweepIntervalsMs` are the values the three files receive.
 *
 * Deliberately NOT folded into `./env-registry.ts` — that registry is scoped
 * to `daemon.json`-backed `MarsConfig` fields (see its own file header);
 * these are ad hoc timer knobs with no `daemon.json` counterpart, same
 * category `env-registry.ts` calls out as later, separate migration work.
 * `resolveControlLevers` in `./levers.ts` is the closer precedent: an
 * injectable `(env = process.env) => value` resolver, called by its
 * consumer(s) rather than cached, so a knob picks up a changed `process.env`
 * on the next daemon boot without this module needing to know when that is.
 */

const msFromEnv = (env: NodeJS.ProcessEnv, varName: string, fallbackMs: number): number =>
  Number(env[varName] ?? fallbackMs)

export interface DrainIntervalsMs {
  alertDismisser: number
  actionQueueRepopulator: number
  blockerResolution: number
  recoverySpawner: number
  recoveryAbandoned: number
  subthreadCloser: number
  archivePrompter: number
  recipeConversationNotice: number
  failureConversationNotice: number
  arcVerifier: number
  archiveEntries: number
  worktreeReclaim: number
  gateFixSteward: number
}

/** Cadences for `drains.ts`'s `DRAINS` registry. @param env injectable for hermetic tests; defaults to `process.env`. */
export const resolveDrainIntervalsMs = (env: NodeJS.ProcessEnv = process.env): DrainIntervalsMs => ({
  alertDismisser: msFromEnv(env, 'MARS_ALERT_DRAIN_MS', 30_000),
  actionQueueRepopulator: msFromEnv(env, 'MARS_ACTION_QUEUE_REPOPULATOR_DRAIN_MS', 30_000),
  blockerResolution: msFromEnv(env, 'MARS_BLOCKER_RESOLUTION_DRAIN_MS', 30_000),
  recoverySpawner: msFromEnv(env, 'MARS_RECOVERY_SPAWNER_DRAIN_MS', 30_000),
  recoveryAbandoned: msFromEnv(env, 'MARS_RECOVERY_ABANDONED_DRAIN_MS', 30_000),
  subthreadCloser: msFromEnv(env, 'MARS_CLOSE_SUBTHREAD_ON_TERMINAL_EVENT_DRAIN_MS', 30_000),
  archivePrompter: msFromEnv(env, 'MARS_ARCHIVE_PROMPT_DRAIN_MS', 30_000),
  recipeConversationNotice: msFromEnv(env, 'MARS_RECIPE_CONVERSATION_NOTICE_DRAIN_MS', 30_000),
  failureConversationNotice: msFromEnv(env, 'MARS_FAILURE_CONVERSATION_NOTICE_DRAIN_MS', 1_000),
  arcVerifier: msFromEnv(env, 'MARS_ARC_VERIFIER_DRAIN_MS', 30_000),
  archiveEntries: msFromEnv(env, 'MARS_ARCHIVE_ENTRIES_DRAIN_MS', 30_000),
  worktreeReclaim: msFromEnv(env, 'MARS_WORKTREE_RECLAIM_DRAIN_MS', 10 * 60 * 1_000),
  gateFixSteward: msFromEnv(env, 'MARS_GATE_FIX_STEWARD_DRAIN_MS', 30_000),
})

export interface SchedulerIntervalsMs {
  pollFallback: number
  queuedDispatchSweep: number
}

/** Cadences for `scheduler.ts`'s poll-fallback and queued-dispatch-sweep timers. @param env injectable for hermetic tests; defaults to `process.env`. */
export const resolveSchedulerIntervalsMs = (
  env: NodeJS.ProcessEnv = process.env,
): SchedulerIntervalsMs => ({
  pollFallback: msFromEnv(env, 'MARS_DRAIN_POLL_MS', 30_000),
  queuedDispatchSweep: msFromEnv(env, 'MARS_QUEUED_DISPATCH_SWEEP_MS', 30_000),
})

export interface SweepIntervalsMs {
  committerLifetime: number
  staleSweep: number
  orphanSweep: number
  observabilityWatchdog: number
  dbBusyWatchdog: number
  outboxPrune: number
  observabilitySweep: number
  kpiSnapshot: number
  noticeSweep: number
  backlogCheck: number
  backlogSustain: number
  reflectDetector: number
  /** Shared cadence for stale-queued-watchdog, awaiting-validation-watchdog and phantom-watchdog. */
  phantomWatchdog: number
  /**
   * Cadence for the lever-gate-sweep that reconciles lever recipes against the
   * registered gate set and raises verify-uncovered proposals for any gap.
   * Defaults to 1 h — the registry is static and the gate set changes rarely.
   */
  leverGateSweep: number
}

/** Cadences (+ the committer lifetime and backlog-sustain thresholds) for `sweeps.ts`'s `SWEEPS` registry. @param env injectable for hermetic tests; defaults to `process.env`. */
export const resolveSweepIntervalsMs = (env: NodeJS.ProcessEnv = process.env): SweepIntervalsMs => ({
  committerLifetime: msFromEnv(env, 'MARS_COMMITTER_LIFETIME_MS', 45 * 60_000),
  staleSweep: msFromEnv(env, 'MARS_STALE_SWEEP_MS', 5 * 60_000),
  orphanSweep: msFromEnv(env, 'MARS_ORPHAN_SWEEP_MS', 5 * 60_000),
  observabilityWatchdog: msFromEnv(env, 'MARS_OBSERVABILITY_WATCHDOG_MS', 5 * 60_000),
  dbBusyWatchdog: msFromEnv(env, 'MARS_DB_BUSY_WATCHDOG_MS', 30_000),
  outboxPrune: msFromEnv(env, 'MARS_OUTBOX_PRUNE_INTERVAL_MS', 60_000),
  observabilitySweep: msFromEnv(env, 'MARS_OBSERVABILITY_SWEEP_MS', 60 * 60_000),
  kpiSnapshot: msFromEnv(env, 'MARS_KPI_SNAPSHOT_MS', 60 * 60_000),
  noticeSweep: msFromEnv(env, 'MARS_NOTICE_SWEEP_MS', 60 * 60_000),
  backlogCheck: msFromEnv(env, 'MARS_BACKLOG_CHECK_MS', 10_000),
  backlogSustain: msFromEnv(env, 'MARS_BACKLOG_SUSTAIN_MS', 60_000),
  reflectDetector: msFromEnv(env, 'MARS_REFLECT_DETECTOR_MS', 5 * 60_000),
  phantomWatchdog: msFromEnv(env, 'MARS_PHANTOM_WATCHDOG_MS', 5 * 60_000),
  leverGateSweep: msFromEnv(env, 'MARS_LEVER_GATE_SWEEP_MS', 60 * 60_000),
})

/**
 * `sweeps.ts`'s notice-sweep reads `INTEGRATION_BRANCH` (not a `MARS_*` var —
 * shared with `merge.ts` and `server.ts`, which are out of this module's
 * scope and keep their own reads for now).
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const resolveIntegrationBranch = (env: NodeJS.ProcessEnv = process.env): string =>
  env.INTEGRATION_BRANCH ?? 'main'

/**
 * Cadence for `lib/git/checkpoint.ts`'s periodic coder-checkpoint timer.
 * Same category as the drain/sweep knobs above: an ad hoc `MARS_*_MS` timer
 * override with no `daemon.json` counterpart.
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const resolveCodeCheckpointIntervalMs = (env: NodeJS.ProcessEnv = process.env): number =>
  msFromEnv(env, 'MARS_CODE_CHECKPOINT_INTERVAL_MS', 3 * 60 * 1_000)

/**
 * Timeout for the `npm view <pkg> versions --json` registry lookup in
 * `daemon/baseline-repair-wiring.ts`.
 *
 * Unlike {@link msFromEnv}, a non-numeric override falls back to the default
 * rather than yielding `NaN` — a `NaN` timeout would silently disable the
 * bound on a network call the baseline repairer blocks on.
 * @param env injectable for hermetic tests; defaults to `process.env`.
 */
export const resolveNpmViewTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
  Number(env.MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS) || 15_000
