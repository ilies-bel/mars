/**
 * Scoring pool (PRD 6cf85bc9) — the daemon-side dispatcher for post-instance
 * Scorer runs.
 *
 * Mirrors the daemon worker-pool discipline (pending set + drain() behind a
 * per-kind cap) but with its OWN semaphore, deliberately separate from the
 * task dispatch semaphores: a scoring run is NOT a Task (no queue row, no
 * recovery, no KPI/action-queue distortion) and must never compete for an
 * implement slot. The `task.completed` bus handler only enqueues the id here
 * and returns — no emit-then-dispatch from the handler itself.
 *
 * Cap: MARS_MAX_SCORING (default 2). Every scored instance costs exactly one
 * Haiku-class judge call, so the cap bounds concurrent judge spend.
 *
 * Failure posture: any error from a scoring run is logged and dropped —
 * level-triggered, no retry, and the scored task's state is never touched.
 */

export interface ScoringPool {
  /** Enqueue a completed task id for scoring; duplicates are absorbed. */
  enqueue(taskId: string): void
  /** Ids waiting for a slot (introspection/tests). */
  pendingCount(): number
  /** Ids currently being scored (introspection/tests). */
  inFlightCount(): number
  /** Resolves once the pool is fully idle (tests). */
  onIdle(): Promise<void>
}

export interface CreateScoringPoolOptions {
  /** Max concurrent scoring runs. */
  limit: number
  log: (msg: string) => void
  /**
   * The scoring run for one task id. Production wires
   * `runScorersForTask(taskId, { traceStore })`; tests inject a stub.
   */
  runScoring: (taskId: string) => Promise<void>
}

export const resolveScoringLimit = (): number => {
  const raw = Number.parseInt(process.env.MARS_MAX_SCORING ?? '', 10)
  return Number.isInteger(raw) && raw > 0 ? raw : 2
}

export const createScoringPool = (
  opts: CreateScoringPoolOptions,
): ScoringPool => {
  const pending: string[] = []
  const pendingSet = new Set<string>()
  const inFlight = new Set<string>()
  let active = 0
  let idleResolvers: Array<() => void> = []

  const notifyIfIdle = (): void => {
    if (active === 0 && pending.length === 0) {
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  const drain = (): void => {
    while (active < opts.limit && pending.length > 0) {
      const taskId = pending.shift()
      if (taskId === undefined) break
      pendingSet.delete(taskId)
      if (inFlight.has(taskId)) continue
      inFlight.add(taskId)
      active += 1
      void opts
        .runScoring(taskId)
        .catch((err: unknown) => {
          // A broken scoring run must NEVER escape: it would become an
          // unhandledRejection and kill the daemon. Log and drop.
          opts.log(
            `[scorer] ${taskId} scoring run errored: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        })
        .finally(() => {
          active -= 1
          inFlight.delete(taskId)
          drain()
          notifyIfIdle()
        })
    }
    notifyIfIdle()
  }

  return {
    enqueue(taskId: string): void {
      if (pendingSet.has(taskId) || inFlight.has(taskId)) return
      pending.push(taskId)
      pendingSet.add(taskId)
      drain()
    },
    pendingCount: () => pending.length,
    inFlightCount: () => inFlight.size,
    onIdle: () =>
      active === 0 && pending.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleResolvers.push(resolve)
          }),
  }
}
