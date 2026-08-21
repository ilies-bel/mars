/**
 * Executor Port — running one agent CLI invocation and reporting its
 * transcript, session id and exit, abstracted behind a swappable
 * implementation (ADR-0097 "Every seam is a cordis service Port with
 * serializable contracts").
 *
 * {@link ExecutorRunArgs} and {@link RunAgentResult} are plain,
 * JSON-serializable data — no functions, no streams, no `AbortSignal`, no
 * process handles — so a future out-of-process implementation ("run the agent
 * in a managed sandbox", "dispatch it to a remote runner") is a drop-in
 * registration behind one adapter file, not a redesign.
 * `__tests__/serializable.test.ts` pins that property with a
 * `JSON.parse(JSON.stringify(args))` round-trip.
 *
 * One kind is registered today (see `registry.ts`):
 *   - `local` — wraps `runClaudeCode` (`../../lib/git/claude`), spawning the
 *     agent CLI as a local subprocess in the task worktree. This is the
 *     default binding, so behaviour is identical to calling the wrapper
 *     directly. Selected by `MARS_EXECUTOR_KIND` (see
 *     `../../config/registry.ts`'s `executor` Port entry) via
 *     `resolveExecutor`.
 *
 * The concrete module this port fronts — `core/lib/git/claude.ts` — is off
 * limits to every caller outside this directory; the `executor-port-only`
 * rule in `.dependency-cruiser.cjs` enforces it. The non-`run()` half of the
 * agent vocabulary (the subprocess streamer, the env builder, the argv
 * builder, the blank-prompt guard) is re-exported from
 * `./executor-helpers.ts`; this module owns the types.
 */
import type { RunAgentArgs, RunAgentResult } from '../../lib/git/claude'

/**
 * Re-exported agent vocabulary that callers outside this port still need to
 * *describe* a run or read its result — the effort/permission enums, the
 * subprocess result shape, and the agent result shape — as opposed to the
 * `Executor.run` contract below, which *executes* one. Re-exported here
 * (rather than left as direct `core/lib/git/claude` imports) so the
 * `executor-port-only` arch-guard rule holds: every outside caller reaches
 * `claude.ts`'s types through this port directory, never around it
 * (ADR-0097). See `./executor-helpers.ts` for the function-level counterpart.
 */
export type {
  AgentEffort,
  AgentPermissionMode,
  RunAgentArgs,
  RunAgentResult,
  RunSubprocessResult,
} from '../../lib/git/claude'

/**
 * The Port-legal request shape for an {@link Executor}. Identical to
 * `RunAgentArgs` minus the three members that fail the Port acceptance test —
 * the streaming callback (`onEvent`), a live `AbortSignal` (`externalAbort`),
 * and a process-artifact callback (`onPid`) — so the request can cross a
 * remote adapter (HTTP/webhook/queue) unchanged, not just an in-process call.
 *
 * The stripped members are not lost: a local implementation still wants
 * streaming, cancellation and PID tracking, so `Executor.run` accepts them out
 * of band as {@link ExecutorRunContext}, the same way a remote adapter would
 * accept a deadline instead of a signal.
 */
export type ExecutorRunArgs = Omit<RunAgentArgs, 'onEvent' | 'externalAbort' | 'onPid'>

/**
 * In-process-only extras an implementation MAY honour, passed out of band so
 * {@link ExecutorRunArgs} stays wire-crossable. Every member is optional and
 * every member is meaningless across a process boundary, so a remote
 * implementation simply ignores this argument.
 *
 * Structurally this is the provider layer's `HeadlessRunContext`
 * (`../../workers/provider-types.ts`) — the same three fields, split off the
 * same serializable request for the same reason — which is why the claude
 * headless adapter forwards its `opts`/`ctx` pair straight through.
 */
export type ExecutorRunContext = Pick<RunAgentArgs, 'onEvent' | 'externalAbort' | 'onPid'>

/**
 * The Executor Port contract. Callers resolve an implementation through
 * `registry.ts` (`resolveExecutor` for the env-selected kind,
 * `requireExecutor(kind)` for a directly-named one), never by importing a
 * concrete implementation module (ADR-0097). Swapping the execution backend
 * is then one binding change rather than an edit per call site — the problem
 * the eleven direct `runClaudeCode` importers used to have.
 */
export interface Executor {
  /** Stable identifier of this implementation (matches its registry.ts `kind`). */
  readonly kind: string
  /** Run one agent invocation described by `args` and report its transcript and exit. */
  run(args: ExecutorRunArgs, ctx?: ExecutorRunContext): Promise<RunAgentResult>
}
