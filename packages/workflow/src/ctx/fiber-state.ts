/**
 * Mars-owned runtime mirror of cordis's `FiberState`.
 *
 * WHY THIS FILE EXISTS — `FiberState` is declared in `@deepseek-ai/cordis` as a
 * `const enum`. TypeScript erases const enums from the emitted JavaScript, and
 * cordis ships pre-built `lib/index.js`, so the package's runtime exports do
 * NOT include `FiberState`:
 *
 *     import { FiberState } from '@deepseek-ai/cordis'  // ← compiles green,
 *     FiberState.ACTIVE                                 //   throws at runtime
 *
 * Mars runs under `tsx`/esbuild, which does not inline const-enum members
 * either, so that read is `undefined.ACTIVE` — a `TypeError` at the first
 * lifecycle comparison. The rule is therefore:
 *
 *   **`FiberState` may only ever be imported as a TYPE.** Compare fiber states
 *   against {@link FiberState} (this frozen numeric mirror) instead.
 *
 * `test/ctx/fiber-state.test.ts` parses the shipped `fiber.d.ts` and fails if
 * this mirror ever drifts from the enum it mirrors, and asserts that the
 * package still exports no runtime `FiberState`.
 */

import type { Fiber, FiberState as CordisFiberState } from '@deepseek-ai/cordis';

/**
 * The lifecycle states a {@link Fiber} moves through, as runtime values.
 *
 * `PENDING` waiting for required services · `LOADING` the plugin callback is
 * running · `ACTIVE` loaded and providing · `FAILED` the callback or its config
 * threw · `DISPOSED` removed, cannot restart · `UNLOADING` disposers running.
 */
export const FiberState = Object.freeze({
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const);

/** The union of {@link FiberState} values. Structurally identical to cordis's const enum. */
export type FiberState = (typeof FiberState)[keyof typeof FiberState];

/** Human-readable name of a fiber state, for logs and diagnostics. */
export function fiberStateName(state: FiberState | CordisFiberState): string {
  for (const [name, value] of Object.entries(FiberState)) {
    if (value === state) return name;
  }
  return `UNKNOWN(${String(state)})`;
}

/**
 * Whether `fiber` is loaded and providing. Only an ACTIVE fiber's services are
 * visible to a strict `ctx.get(name)`.
 */
export function isActive(fiber: Fiber): boolean {
  return fiber.state === FiberState.ACTIVE;
}

/**
 * Whether `fiber` has been disposed for good. A disposed fiber cannot restart,
 * and registering an effect on it throws `CordisError('INACTIVE_EFFECT')`.
 *
 * Reads `uid` rather than `state`: cordis clears `uid` to `null` at the top of
 * disposal, before the UNLOADING → DISPOSED transition has settled, and
 * `assertActive()` keys off exactly that.
 */
export function isDisposed(fiber: Fiber): boolean {
  return fiber.uid === null;
}

/**
 * Compile-time proof that the mirror above still agrees with cordis's const
 * enum. If upstream renumbers a member, one of these aliases stops resolving
 * and `tsc --noEmit` fails here rather than at some far-away comparison.
 */
type Mirrors<M extends C, C> = [M, C];
type _PENDING = Mirrors<typeof FiberState.PENDING, CordisFiberState.PENDING>;
type _LOADING = Mirrors<typeof FiberState.LOADING, CordisFiberState.LOADING>;
type _ACTIVE = Mirrors<typeof FiberState.ACTIVE, CordisFiberState.ACTIVE>;
type _FAILED = Mirrors<typeof FiberState.FAILED, CordisFiberState.FAILED>;
type _DISPOSED = Mirrors<typeof FiberState.DISPOSED, CordisFiberState.DISPOSED>;
type _UNLOADING = Mirrors<typeof FiberState.UNLOADING, CordisFiberState.UNLOADING>;

/** Keeps the assertion aliases above referenced (they are proofs, not exports). */
export type FiberStateMirrorProof = [
  _PENDING,
  _LOADING,
  _ACTIVE,
  _FAILED,
  _DISPOSED,
  _UNLOADING,
];
