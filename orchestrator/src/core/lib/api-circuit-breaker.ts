/**
 * In-process circuit breaker tracking whether the Anthropic API is reachable.
 *
 * Consumers (detector, dispatcher, probe) can open the breaker when they
 * detect a ConnectionRefused cascade, and close it when connectivity is
 * restored. open() is idempotent — a second open() while already open is a
 * no-op; the original reason and openedAt are preserved until close() runs.
 */

export type BreakerState = {
  open: boolean
  reason: string | null
  openedAt: number | null
}

type MutableBreakerState = {
  open: boolean
  reason: string | null
  openedAt: number | null
}

const _state: MutableBreakerState = {
  open: false,
  reason: null,
  openedAt: null,
}

export const apiCircuitBreaker = {
  /**
   * Trip the breaker. No-op when already open (preserves original reason and
   * openedAt). `at` defaults to Date.now() and exists so tests can supply a
   * deterministic timestamp without mocking the global.
   */
  open(reason: string, at?: number): void {
    if (_state.open) return
    _state.open = true
    _state.reason = reason
    _state.openedAt = at ?? Date.now()
  },

  /** Reset the breaker to closed. Clears reason and openedAt. */
  close(): void {
    _state.open = false
    _state.reason = null
    _state.openedAt = null
  },

  /** True when the breaker is tripped. */
  isOpen(): boolean {
    return _state.open
  },

  /** Snapshot of current breaker state. */
  state(): BreakerState {
    return { open: _state.open, reason: _state.reason, openedAt: _state.openedAt }
  },
}
