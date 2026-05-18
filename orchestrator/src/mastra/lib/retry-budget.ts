/**
 * Per-failure-signature self-heal retry budget.
 *
 * The orchestrator's sweeper consults this budget to decide whether to
 * enqueue another self-heal fix-task for a given (parent, failure_signature)
 * pair. Most signatures get a single retry — that's enough to absorb the
 * common transient flake without spending money on a runaway loop. The
 * `daemon-killed` signature is the documented exception: a worker killed
 * by an external SIGKILL is much more likely to succeed on a fresh
 * dispatch, so it gets three attempts before we give up and leave the
 * parent blocked.
 *
 * Lookup is intentionally trivial — a frozen map plus a getter that falls
 * back to the default. Callers ask `getRetryBudget(signature)` rather
 * than touching the map directly so we can change the storage shape later
 * without rippling through the call sites.
 */

export const DEFAULT_RETRY_BUDGET = 1

export const retryBudgetBySignature: Readonly<Record<string, number>> =
  Object.freeze({
    'daemon-killed': 3,
  })

export const getRetryBudget = (signature: string): number =>
  retryBudgetBySignature[signature] ?? DEFAULT_RETRY_BUDGET
