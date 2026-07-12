/**
 * Subscriber name registry — a lightweight singleton that lets each
 * subscriber module self-register its name at import time.
 *
 * Each subscriber module calls {@link registerSubscriberName} once at
 * module-initialization level, alongside its exported NAME constant.
 * The ghost-subscriber reconciler reads {@link knownSubscriberNames}
 * instead of maintaining a hardcoded import list — so adding a new
 * subscriber no longer requires editing reconcilers.ts.
 *
 * **Ordering contract**: subscriber modules must be imported before the
 * ghost-subscriber reconcile sweep runs. In production the daemon wires
 * up all subscribers during startup before the reconcile pass, so this
 * ordering is already guaranteed. Tests that exercise the sweep must
 * import the subscriber modules themselves to mirror that order.
 */

const _registry = new Set<string>()

/**
 * Record `name` as a code-declared subscriber. Idempotent — adding the
 * same name twice is a no-op (Set semantics). Intended to be called at
 * module-initialization level in each subscriber module.
 */
export function registerSubscriberName(name: string): void {
  _registry.add(name)
}

/**
 * Return the set of all code-declared subscriber names that have
 * self-registered via {@link registerSubscriberName}. The returned
 * reference is a live, read-only view of the internal registry set.
 */
export function knownSubscriberNames(): ReadonlySet<string> {
  return _registry
}
