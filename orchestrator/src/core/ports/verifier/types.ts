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
 * Three kinds are registered today (see `registry.ts`):
 *   - `local` — wraps `verifyChanges` (`../../lib/git/verify`), spawning each
 *     verify step as a local subprocess. This is the default binding, so
 *     behaviour is identical to calling the runner directly. Selected by
 *     `MARS_VERIFIER_KIND` (see `../../config/registry.ts`'s `verifier`
 *     Port entry) via {@link resolveVerifier}.
 *   - `remote-http` (`./remote-http.ts`) — POSTs the args to a configured
 *     HTTP endpoint (e.g. CI) and reports back its `VerifierRunResult`.
 *     Shares `local`'s request/result shapes, so it is env-selectable
 *     through the same `MARS_VERIFIER_KIND` knob.
 *   - `review` (`review-verifier.ts`) — wraps the `review` workflow
 *     primitive (`../../../tools/verify/review.ts`): worktree/dirty-main
 *     preflight, gate selection *and* execution (delegating to the `local`
 *     kind internally for the actual subprocess run), fix-task dispatch, the
 *     LLM full-review path, and the manual-QA park. Its request/result shape
 *     (`ReviewOpts`/`ReviewResult`) is structurally unrelated to `local`'s —
 *     like the Reflector Port's four kinds (`../reflector/types.ts`), a
 *     caller already knows it wants `review` and resolves it directly via
 *     `requireVerifier<ReviewOpts, ReviewResult, ReviewVerifierContext>('review')`
 *     rather than through env-driven resolution.
 *
 * `Verifier` is generic over its request/result/context shapes (default type
 * parameters bind to the `local` kind's shapes, so every existing bare
 * `Verifier` reference keeps working unchanged) precisely so a second,
 * structurally-unrelated kind like `review` can implement the same Port
 * contract without warping `local`'s types — the same reasoning
 * `Reflector<TRequest, TResult>` documents for its four kinds.
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
 * `registry.ts` (`resolveVerifier` for the env-selected `local` kind,
 * `requireVerifier(kind)` for a directly-named kind like `review`), never by
 * importing a concrete implementation module (ADR-0097).
 *
 * Generic so a structurally-unrelated kind (`review`) can implement this
 * same contract with its own request/result/context shapes; the default
 * type parameters keep every existing bare `Verifier` reference (the `local`
 * kind, `__tests__/serializable.test.ts`'s fakes) unchanged.
 */
export interface Verifier<
  TArgs = VerifierRunArgs,
  TResult = VerifierRunResult,
  TContext = VerifierRunContext,
> {
  /** Stable identifier of this implementation (matches its registry.ts `kind`). */
  readonly kind: string
  /** Run the verify gates described by `args` and report the verdict. */
  run(args: TArgs, ctx?: TContext): Promise<TResult>
}
