/**
 * Reversible registration.
 *
 * Cordis owns the machinery — `ctx.effect()` collects disposers per fiber and
 * runs them in reverse order on unload, and `DisposableList` is the collection
 * behind it (both re-exported from this package's barrel). What survives here
 * is the *name*: `Disposer` is the return type of every registering call in the
 * Mars public API (`ctx.provide`, `registerProvider`, `registerPrimitive`,
 * `registerVerifyHeuristic`, …), and four orchestrator modules import it.
 *
 * It is deliberately `() => void` rather than cordis's `Disposable<T = any>`:
 * a Mars registration disposer returns nothing, and the engine bans explicit
 * `any` (ADR-0052).
 */

/** Reverses one registration. Calling it more than once must be safe. */
export type Disposer = () => void;
