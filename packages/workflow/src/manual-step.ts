// ---------------------------------------------------------------------------
// Manual step park / resume primitives
//
// When a workflow step carries mode === 'manual', the orchestrator domain
// layer calls awaitManualDone(runId, stepName) to suspend the step until the
// operator signals completion. The daemon's POST /step/done route calls
// resolveManualStep(runId, stepName) to unblock the waiting step.
//
// Key design properties:
//   - The pending map is module-level so the daemon's HTTP handler and the
//     in-flight workflow share the same memory space.
//   - resolveManualStep returns false for stale/duplicate calls (the step
//     already resolved or was never registered), making step-done idempotent.
//   - After a daemon restart the in-memory map is empty; the fallback path in
//     handleStepDone re-queues via the sentinel mechanism so the operator can
//     use 'mars step done' again after the restart.
// ---------------------------------------------------------------------------

/** Key format for the pending manual-step map. */
const manualKey = (runId: string, stepName: string): string => `${runId}::${stepName}`;

/** Live promise resolvers for in-flight manual steps, keyed by (runId, stepName). */
const pendingManualSteps = new Map<string, () => void>();

/**
 * Register a pending manual step and return a promise that resolves only when
 * {@link resolveManualStep} is called for the same `(runId, stepName)` pair.
 *
 * Called by the domain layer (primitives) when a step's `mode === 'manual'`:
 * the step body awaits the returned promise, suspending the workflow until the
 * operator signals completion.
 */
export function awaitManualDone(runId: string, stepName: string): Promise<void> {
  return new Promise<void>((resolve) => {
    pendingManualSteps.set(manualKey(runId, stepName), resolve);
  });
}

/**
 * Resolve a pending manual step registered by {@link awaitManualDone}.
 *
 * Called by the daemon's `step/done` handler. Returns `true` if a pending
 * promise was found and resolved, `false` if the key was not in the map
 * (stale call, already resolved, or daemon restarted and lost the promise).
 */
export function resolveManualStep(runId: string, stepName: string): boolean {
  const key = manualKey(runId, stepName);
  const resolve = pendingManualSteps.get(key);
  if (!resolve) return false;
  pendingManualSteps.delete(key);
  resolve();
  return true;
}
