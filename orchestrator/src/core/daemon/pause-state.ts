/**
 * The daemon's ONE authoritative dispatch-pause state.
 *
 * Before this module there were two independent flags: the daemon's in-memory
 * `isPaused` boolean and the signature-storm breaker's durable `tripped` row.
 * Nothing reconciled them, so `mars daemon status` could report PAUSED with no
 * operator pause anywhere on disk (the pause came purely from a storm trip),
 * and the old resume control cleared one flag but not the other — leaving
 * dispatch either dead or silently resumed with the breaker still armed.
 *
 * Now every pause goes through one controller that records WHY:
 *
 *   'operator' — a persisted operator dispatch pause
 *   'storm'    — the signature-storm circuit breaker tripped
 *   'quota'    — the provider rejected runs on a rate/spend limit
 *
 * The reason is what makes resume coherent: the daemon knows a `storm` pause
 * also owns the durable `tripped` flag and clears both together, and status
 * can tell the operator which of the three is holding dispatch down.
 *
 * First cause wins. A second pause while already paused does NOT overwrite the
 * reason or the timestamp and returns `false`, so callers (quota handler,
 * storm handler) keep their "already paused — do not fire duplicate
 * side-effects" guard by reading the return value instead of a bare boolean.
 */

/** Why dispatch is paused. */
export type PauseReason = 'operator' | 'storm' | 'quota'

/** An immutable snapshot of the daemon's dispatch-pause state. */
export interface DispatchPauseState {
  /** True while the dispatch loop is suspended. */
  paused: boolean
  /** Which cause holds dispatch down, or null when running. */
  reason: PauseReason | null
  /** ISO-8601 instant the current pause began, or null when running. */
  since: string | null
  /** Human-readable detail for status output, or null. */
  detail: string | null
}

const RUNNING: DispatchPauseState = {
  paused: false,
  reason: null,
  since: null,
  detail: null,
}

export interface PauseController {
  /** The current snapshot (never mutated in place). */
  get(): DispatchPauseState
  /** Convenience read for the dispatch-loop guard. */
  isPaused(): boolean
  /**
   * Suspend dispatch for `reason`. Returns true when THIS call paused, false
   * when a pause was already in effect (the existing reason is preserved).
   */
  pause(reason: PauseReason, detail?: string): boolean
  /**
   * Resume dispatch. Returns the state that was cleared, so the caller can
   * see which cause it just released (e.g. a 'storm' resume must also clear
   * the durable breaker flag). Resuming while running is a no-op that returns
   * the running state.
   */
  resume(): DispatchPauseState
}

export interface CreatePauseControllerOptions {
  /** Injected clock; defaults to `Date`. Tests pin it for deterministic `since`. */
  now?: () => Date
  /** Called after every state transition (pause and resume). */
  onChange?: (state: DispatchPauseState) => void
}

export const createPauseController = (
  opts: CreatePauseControllerOptions = {},
): PauseController => {
  const now = opts.now ?? ((): Date => new Date())
  let state: DispatchPauseState = RUNNING

  return {
    get: () => state,
    isPaused: () => state.paused,
    pause: (reason: PauseReason, detail?: string): boolean => {
      if (state.paused) return false
      state = {
        paused: true,
        reason,
        since: now().toISOString(),
        detail: detail ?? null,
      }
      opts.onChange?.(state)
      return true
    },
    resume: (): DispatchPauseState => {
      const previous = state
      if (!previous.paused) return previous
      state = RUNNING
      opts.onChange?.(state)
      return previous
    },
  }
}

/**
 * One-line operator-facing rendering of a pause state, used by
 * `mars daemon status`. Returns null when dispatch is running.
 */
export const describePauseState = (state: DispatchPauseState): string | null => {
  if (!state.paused) return null
  const reason = state.reason ?? 'unknown'
  const detail = state.detail !== null ? ` — ${state.detail}` : ''
  const since = state.since !== null ? ` (since ${state.since})` : ''
  return `reason: ${reason}${detail}${since}`
}
