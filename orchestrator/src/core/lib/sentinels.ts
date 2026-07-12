/**
 * Canonical lease-owner sentinels used across the daemon and workflow
 * primitives to distinguish workflow-held park slots from human-held leases.
 *
 * A sentinel is a well-known string value that identifies an internal
 * actor (the workflow engine) rather than a real human operator.  The
 * attach handler uses these sentinels to decide whether a task can be
 * taken over: a sentinel-owned slot is always takeable; a human-owned
 * lease refuses attachment by a different owner.
 */

/**
 * Lease-owner sentinel written when a workflow parks a task awaiting
 * human interaction — either via the `awaitHuman` primitive or the
 * `onManualPark` hook.  The attach handler recognises this as a
 * takeover-able slot.
 */
export const AWAIT_HUMAN_SENTINEL = 'workflow:await-human' as const
