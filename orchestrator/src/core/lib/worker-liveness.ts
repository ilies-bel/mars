/**
 * worker-liveness — the one seam that answers "does a worker process still
 * exist for this task?".
 *
 * WHY THIS EXISTS
 *
 * `tasks.status = 'running'` is a *claim*, not a fact. Nothing in the schema
 * records who is running the task: there is no `pid` column, no
 * `last_heartbeat` column, and `updated_at` only moves when some code path
 * happens to write the row — a coder can stream output for twenty minutes
 * without touching it. So a `running` row proves nothing about liveness on
 * its own, and any policy built on row age alone is a timeout, not a
 * liveness check.
 *
 * The authoritative liveness signal lives in memory: the daemon's
 * `TaskFlightTracker` holds exactly one entry per worker it spawned, from
 * `claim`/`commitInFlight` until the release closure runs. A daemon owns
 * every worker process it starts, so within a daemon process:
 *
 *   in-flight (or claimed)  ⟺  a worker exists for this task
 *
 * That signal is only reachable from `startDaemon`'s scope. This module is the
 * narrow registry that publishes it to modules which must consult liveness but
 * have no path to the tracker (notably `lib/main-dirty.ts`, which decides
 * whether it is safe to park a task behind an existing main-committer).
 *
 * TRI-STATE ON PURPOSE
 *
 * `probeWorkerLiveness` returns `'unknown'` when no probe is installed — i.e.
 * the caller is not running inside a daemon (the `mars sync` CLI path, unit
 * tests). Callers must treat `'unknown'` as "cannot tell, assume alive": a
 * process outside the daemon has no business declaring another process's
 * worker dead. Only an explicit `'dead'` — a live daemon that positively knows
 * it is not running this task — justifies reaping.
 */

/** Predicate over task ids: true iff this daemon currently owns a worker for it. */
export type WorkerLivenessProbe = (taskId: string) => boolean

/** Liveness verdict. `unknown` means "no daemon-local knowledge; assume alive". */
export type WorkerLiveness = 'alive' | 'dead' | 'unknown'

let installedProbe: WorkerLivenessProbe | null = null

/**
 * Publish the daemon's in-flight knowledge. Called once from `startDaemon`
 * right after the `TaskFlightTracker` is created, and cleared with `null` on
 * shutdown so a stopped daemon never leaves a stale probe answering for a
 * tracker that no longer dispatches anything.
 */
export const setWorkerLivenessProbe = (probe: WorkerLivenessProbe | null): void => {
  installedProbe = probe
}

/**
 * Ask whether a worker process still exists for `taskId`.
 *
 * Returns `'unknown'` outside a daemon. Inside a daemon the answer is exact:
 * the tracker is the sole record of every worker the daemon spawned.
 */
export const probeWorkerLiveness = (taskId: string): WorkerLiveness => {
  if (installedProbe === null) return 'unknown'
  return installedProbe(taskId) ? 'alive' : 'dead'
}
