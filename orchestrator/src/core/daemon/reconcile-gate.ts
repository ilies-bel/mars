/**
 * Boot-time reconcile gate.
 *
 * The daemon's startup reconcile runs as a fire-and-forget promise after the
 * HTTP server starts listening.  Operator handlers that modify task state (e.g.
 * `mars continue`) can race with the reconcile pass and encounter task statuses
 * that are mid-transition, producing spurious IllegalTransitionErrors.
 *
 * This module provides a thin gate that:
 *
 *  - the daemon signals complete via `markReconcileComplete()` once the pass
 *    finishes (successfully or not — errors release the gate so handlers never
 *    block forever);
 *  - operator handlers call `waitForReconcileWithTimeout(ms)` to defer until
 *    the gate opens, with a cap so a hung reconcile does not block the connection.
 *
 * The gate uses module-level state, which means each `vi.resetModules()` in
 * tests produces a fresh unresolved gate — letting tests exercise both the
 * "gate open" and "gate still pending" paths without shared-state pollution.
 */

let _resolve!: () => void
const _gate: Promise<void> = new Promise<void>((resolve) => {
  _resolve = resolve
})
let _complete = false

/**
 * Signal that the startup reconcile has finished (success **or** error).
 * Idempotent: safe to call more than once.
 */
export const markReconcileComplete = (): void => {
  if (!_complete) {
    _complete = true
    _resolve()
  }
}

/** True once the startup reconcile gate has been opened. */
export const isReconcileComplete = (): boolean => _complete

/**
 * Wait for the startup reconcile to finish, up to `timeoutMs` milliseconds.
 *
 * Returns:
 *  - `'ready'`   — reconcile completed within the timeout window.
 *  - `'timeout'` — the cap was hit before the gate opened; the caller should
 *                  surface a retryable error to the operator.
 */
export const waitForReconcileWithTimeout = (
  timeoutMs: number,
): Promise<'ready' | 'timeout'> => {
  if (_complete) return Promise.resolve('ready')
  return Promise.race<'ready' | 'timeout'>([
    _gate.then(() => 'ready' as const),
    new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs).unref(),
    ),
  ])
}
