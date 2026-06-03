/**
 * TaskFlightTracker — the deep module that owns the dispatch-storm-prevention
 * invariant inside daemon/server.ts (ADR-0024, CONTEXT.md glossary).
 *
 * It hides the four bookkeeping collections the daemon's dispatch loop used to
 * mutate inline:
 *
 *   - inFlight:        Map<taskId, { taskId, kind }>  — committed, running work
 *   - pendingTriage:   Set<taskId>                    — awaiting a triage slot
 *   - pendingImplement:Set<taskId>                    — awaiting an implement slot
 *   - claimedTriage:   Set<taskId>                    — claimed by a drain pass,
 *   - claimedImplement:Set<taskId>                      not yet committed to inFlight
 *
 * THE NAMED INVARIANT (the whole point of this module):
 *
 *   For every taskId, at most one Slot in `inFlight ∪ claimed{Triage,Implement}`
 *   holds it at any instant. A `claim` runs BEFORE `await acquire(sem)` and the
 *   claim clears only AFTER `commitInFlight` has recorded the task in `inFlight`
 *   — so the await-acquire gap (the window that caused the dispatch-storm bug,
 *   where parallel `drain()` passes each picked the same id and started parallel
 *   dispatches before any called `trackInFlight`) is always covered by either a
 *   claim or an inFlight entry, never neither.
 *
 * WHY THE LIFECYCLE IS FORCED BY THE TYPES:
 *
 *   The only way to obtain the release closure is to call `commitInFlight`,
 *   which records the task in `inFlight` (and clears any matching claim) as a
 *   single step. A contributor therefore cannot acquire a release handle
 *   without first committing the in-flight entry, and cannot commit without the
 *   tracker observing the task as in-flight. The natural — and only — usage is:
 *
 *       if (!tracker.claim(id, kind)) return   // (drain-driven kinds only)
 *       await acquire(sem)
 *       const release = tracker.commitInFlight(id, kind)
 *       try { ...run... } finally { release() }
 *
 *   Ordering claim/await/commit/release wrong is not expressible: there is no
 *   way to "release" without a `commitInFlight`, and `commitInFlight` is the
 *   sole producer of the release closure.
 *
 * DELIBERATELY NARROWER THAN A SlotPool: the per-kind semaphores, the `drain`
 * single-flight loop, the per-kind dispatcher closures, and the bus glue all
 * stay in `startDaemon`. This module owns only the four collections and the
 * predicates over them. See ADR-0024 for why the full SlotPool seam was
 * rejected (semaphores already top-level; the invariant is flight-tracker-
 * shaped, not pool-shaped; the two-adapter rule fails today).
 */

export type DispatchKind =
  | 'triage'
  | 'implement'
  | 'refine'
  | 'glossary-write'
  | 'adr-add'

/** A kind that participates in the claim → commit two-phase lifecycle. */
export type ClaimableKind = Extract<DispatchKind, 'triage' | 'implement'>

export interface InFlightEntry {
  taskId: string
  kind: DispatchKind
}

/**
 * The release closure returned by `commitInFlight`. Calling it clears the
 * task's `inFlight` entry. Idempotent: calling it more than once is a no-op,
 * and it only clears the entry it itself committed (so a second `commitInFlight`
 * after a force-drop is never clobbered by a stale release).
 */
export type ReleaseInFlight = () => void

export interface TaskFlightTracker {
  // ── inFlight reads ──────────────────────────────────────────────────────
  /** True iff the task currently holds a committed `inFlight` slot. */
  isInFlight(taskId: string): boolean
  /** The kind of the committed in-flight entry, or undefined if not in flight. */
  inFlightKind(taskId: string): DispatchKind | undefined
  /** Count of committed in-flight entries. */
  inFlightCount(): number
  /** A point-in-time copy of every committed in-flight entry. */
  inFlightSnapshot(): InFlightEntry[]

  // ── claim → commit → release lifecycle ────────────────────────────────────
  /**
   * Reserve a drain-claimable task (triage/implement) BEFORE `await acquire`.
   * Returns false (and reserves nothing) when the task is already claimed for
   * this kind OR already committed in `inFlight` — this is the at-most-once
   * guard that closes the await-acquire gap. The caller must skip dispatch on
   * a false return.
   */
  claim(taskId: string, kind: ClaimableKind): boolean
  /** True iff the task is currently claimed for the given kind. */
  isClaimed(taskId: string, kind: ClaimableKind): boolean
  /**
   * Drop a claim that will NOT be committed (drain bail paths: the row is no
   * longer 'queued', or it gained incomplete blockers between pick and check).
   * No-op if the task was not claimed for this kind.
   */
  unclaim(taskId: string, kind: ClaimableKind): void
  /**
   * Commit the task to `inFlight` and return its release closure. Clears any
   * matching claim atomically (claim-clears-AFTER-commit). This is the SOLE
   * producer of a release closure, which is what forces the
   * commit-before-release lifecycle. Re-committing the same id replaces the
   * entry and invalidates any earlier release closure for it.
   */
  commitInFlight(taskId: string, kind: DispatchKind): ReleaseInFlight

  // ── pending sets ──────────────────────────────────────────────────────────
  /** Push a task into the pending set for its kind so `drainPending` can pick it. */
  enqueuePending(taskId: string, kind: ClaimableKind): void
  /**
   * Iterate the pending ids for a kind in insertion order. The returned
   * iterable is the live set view — callers mutate it via `claim`/`removePending`
   * during iteration exactly as the old inline `for (const id of pendingX)` did.
   */
  drainPending(kind: ClaimableKind): IterableIterator<string>
  /** Remove a single id from a pending set (e.g. once claimed for dispatch). */
  removePending(taskId: string, kind: ClaimableKind): void
  /** Empty both pending sets (shutdown / drain-stop / kill). */
  clearPending(): void

  // ── force release ─────────────────────────────────────────────────────────
  /**
   * Force-clear a committed in-flight entry without going through its release
   * closure. Used only by `handleDrop(force=true)`: the worker still holds the
   * slot but the operator is dropping the row, so the tracker must let `drain`
   * reclaim the semaphore even though the workflow run continues to its natural
   * end. Returns true if an entry was actually cleared.
   */
  forceRelease(taskId: string): boolean
}

export const createTaskFlightTracker = (): TaskFlightTracker => {
  const inFlight = new Map<string, InFlightEntry>()
  const pendingTriage = new Set<string>()
  const pendingImplement = new Set<string>()
  const claimedTriage = new Set<string>()
  const claimedImplement = new Set<string>()

  const claimedSet = (kind: ClaimableKind): Set<string> =>
    kind === 'triage' ? claimedTriage : claimedImplement
  const pendingSet = (kind: ClaimableKind): Set<string> =>
    kind === 'triage' ? pendingTriage : pendingImplement

  return {
    isInFlight: (taskId) => inFlight.has(taskId),
    inFlightKind: (taskId) => inFlight.get(taskId)?.kind,
    inFlightCount: () => inFlight.size,
    inFlightSnapshot: () => Array.from(inFlight.values()),

    claim: (taskId, kind) => {
      // At-most-once: refuse if already claimed for this kind or already
      // committed in flight. This single check is what the dispatch loop used
      // to spell as `if (claimedX.has(id) || inFlight.has(id)) continue`.
      if (claimedSet(kind).has(taskId) || inFlight.has(taskId)) return false
      claimedSet(kind).add(taskId)
      return true
    },
    isClaimed: (taskId, kind) => claimedSet(kind).has(taskId),
    unclaim: (taskId, kind) => {
      claimedSet(kind).delete(taskId)
    },
    commitInFlight: (taskId, kind) => {
      const entry: InFlightEntry = { taskId, kind }
      inFlight.set(taskId, entry)
      // Claim clears only AFTER the inFlight entry is recorded, so the gap is
      // covered the whole time. Only triage/implement are ever claimed; the
      // delete is a harmless no-op for refine/glossary-write/adr-add.
      claimedTriage.delete(taskId)
      claimedImplement.delete(taskId)
      let released = false
      return () => {
        if (released) return
        released = true
        // Only clear our own entry: a force-drop + re-commit could have placed
        // a newer entry under this id; identity-check so a stale release never
        // evicts the live one.
        if (inFlight.get(taskId) === entry) inFlight.delete(taskId)
      }
    },

    enqueuePending: (taskId, kind) => {
      pendingSet(kind).add(taskId)
    },
    drainPending: (kind) => pendingSet(kind).values(),
    removePending: (taskId, kind) => {
      pendingSet(kind).delete(taskId)
    },
    clearPending: () => {
      pendingTriage.clear()
      pendingImplement.clear()
    },

    forceRelease: (taskId) => inFlight.delete(taskId),
  }
}
