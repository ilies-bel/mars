import type { Disposable } from '@deepseek-ai/cordis';

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
 * It is defined in terms of cordis's own `Disposable<T = any>` rather than
 * redeclared as a structurally identical `() => void`: pinning the type
 * parameter to `void` resolves to exactly `() => void` and introduces no
 * `any` at any call site, since the `any` default only applies when the
 * parameter is omitted. The engine still bans explicit `any` (ADR-0052) —
 * this doesn't touch that rule, it just gives cordis's type a
 * domain-meaningful name.
 */

/** Reverses one registration. Calling it more than once must be safe. */
export type Disposer = Disposable<void>;
