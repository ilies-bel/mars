/**
 * Ambient TraceEventStore registry for the Vcs port.
 *
 * The Vcs interface is wire-safe: every method takes a plain serializable spec
 * and returns a plain serializable result. Adding a `store` field to each spec
 * would violate the serializability rule (ADR-0097) and bloat every call site.
 *
 * This module holds a single process-scoped slot that the host (server.ts /
 * daemon startup) arms once via `setAmbientTraceStore`, allowing
 * `local-git.ts` to reconstruct a full `TraceCtx` from the serializable
 * `TraceIdentity` carried on each spec — without leaking store references into
 * the port's public contract.
 *
 * The pattern mirrors how `setLocalGitTraceStore` propagates the store for
 * direct `safeEmit` calls from the port, but serves the separate concern of
 * threading context through to the underlying `../../lib/git/*` helpers.
 */
import type { TraceEventStore } from '../../lib/trace-events-store'

let _store: TraceEventStore | null = null

/**
 * Arm the ambient trace store used by `local-git.ts` to reconstruct a full
 * {@link TraceCtx} from a serializable {@link TraceIdentity} on each Vcs spec.
 *
 * Pass `null` to disarm (e.g. during shutdown). Idempotent — safe to call
 * multiple times. The slot is module-scoped, so this affects every subsequent
 * call to `getAmbientTraceStore()` in the same process.
 *
 * @example
 * // Arm at daemon startup (right after openTraceEventStore resolves):
 * setAmbientTraceStore(traceStore)
 *
 * // Disarm in the shutdown handler (before traceStore.close()):
 * setAmbientTraceStore(null)
 */
export function setAmbientTraceStore(store: TraceEventStore | null): void {
  _store = store
}

/**
 * Return the currently-armed trace store, or `null` when none has been set.
 *
 * Callers that need a full `TraceCtx` should always guard on the return value:
 * ```ts
 * const store = getAmbientTraceStore()
 * if (!store) return undefined
 * return { taskId, originId, phase, store }
 * ```
 */
export function getAmbientTraceStore(): TraceEventStore | null {
  return _store
}
