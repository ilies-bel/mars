/**
 * Verifier Port — running a task's verify gates and reporting the verdict,
 * abstracted behind a swappable implementation (ADR-0097 "Every seam is a
 * cordis service Port with serializable contracts").
 *
 * {@link VerifierRunArgs} and {@link VerifierRunResult} are plain,
 * JSON-serializable data — no functions, no streams, no `AbortSignal`, no
 * process handles — so a future out-of-process implementation (e.g. "verify
 * in CI" over HTTP) is a drop-in registration behind one adapter file, not a
 * redesign. `__tests__/serializable.test.ts` pins that property with a
 * `JSON.parse(JSON.stringify(args))` round-trip.
 *
 * One implementation exists today (see `registry.ts`):
 *   - `local` — wraps `verifyChanges` (`../../lib/git/verify`), spawning each
 *     verify step as a local subprocess. This is the default binding, so
 *     behaviour is identical to calling the runner directly.
 *
 * The active implementation is selected by `MARS_VERIFIER_KIND`
 * (see `../../config/registry.ts`'s `verifier` Port entry).
 */
import type { TraceCtx } from '../../lib/git/internal'
import type { VerifyArgs, VerifyResult } from '../../lib/git/verify'

/**
 * The Port-legal request shape for a {@link Verifier}. Identical to
 * `VerifyArgs` minus the three members that fail the Port acceptance test:
 * a live `AbortSignal` (`signal`), a process-artifact callback
 * (`onChildPid`), and the in-process-only `traceCtx`. What remains — the
 * verify root, the step specs, the branch pair, the changed-file list, the
 * raw spec verify command and the model attribution — is plain data that can
 * cross a remote adapter (HTTP/webhook/queue) unchanged.
 *
 * The stripped members are not lost: a local implementation still wants
 * cancellation and PID tracking, so `Verifier.run` accepts them out of band
 * as {@link VerifierRunContext}, the same way a remote adapter would accept
 * a deadline instead of a signal.
 */
export type VerifierRunArgs = Omit<VerifyArgs, 'traceCtx' | 'signal' | 'onChildPid'>

/**
 * The Port-legal result shape for a {@link Verifier}: the verdict, the
 * per-step records (each carrying its command, exit code and captured
 * stdout/stderr as plain strings), and the echoed model attribution.
 * Structurally identical to `VerifyResult`, which is already serializable —
 * aliased here so callers bind to the Port's vocabulary rather than reaching
 * into the local runner's module.
 */
export type VerifierRunResult = VerifyResult

/**
 * In-process-only extras an implementation MAY honour, passed out of band so
 * {@link VerifierRunArgs} stays wire-crossable. Every member is optional and
 * every member is meaningless across a process boundary, so a remote
 * implementation simply ignores this argument.
 */
export interface VerifierRunContext {
  /** Trace context: each step's shell-out emits a `tool_invoked` event under `phase: 'verify'`. */
  traceCtx?: TraceCtx
  /** Cancellation signal: in-flight step subprocesses are SIGTERM'd then SIGKILL'd. */
  signal?: AbortSignal
  /** Called with each step subprocess's OS PID, for verify-child liveness tracking. */
  onChildPid?: (pid: number) => void
}

/**
 * The Verifier Port contract. Callers resolve an implementation through
 * `registry.ts` (`resolveVerifier`), never by importing a concrete
 * implementation module (ADR-0097).
 */
export interface Verifier {
  /** Stable identifier of this implementation (matches its registry.ts `kind`). */
  readonly kind: string
  /** Run the verify gates described by `args` and report the verdict. */
  run(args: VerifierRunArgs, ctx?: VerifierRunContext): Promise<VerifierRunResult>
}
