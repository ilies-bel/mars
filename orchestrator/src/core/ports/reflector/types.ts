/**
 * Reflector Port — synthesizes reflection findings (draft proposals, scorer
 * suggestions, capability-gap reports, harness-improvement drafts) from
 * post-hoc data: a corpus of recent tasks, a single task arc's full
 * transcripts, an operator session's arc digest, or an exhausted failure arc
 * (ADR-0097 "Every seam is a cordis service Port with serializable
 * contracts").
 *
 * Four kinds are registered today (see `registry.ts`), one per existing
 * reflector shape:
 *   - `token`        — `lib/reflector.ts`'s corpus-level token/lever synthesis.
 *   - `deep-arc`      — `lib/deep-reflector.ts`'s arc-scoped post-mortem.
 *   - `deep-session`  — `lib/deep-reflector.ts`'s session-scoped harness-fitness pass.
 *   - `failure`       — `lib/failure-reflector.ts`'s exhausted-failure-arc advisor.
 *
 * `TRequest`/`TResult` are per-kind rather than one shared shape: the four
 * corpora (`ReflectCorpus`, an arc digest, a session digest,
 * `SpawnFailureReflectorOpts`) are structurally unrelated, and so are their
 * result shapes. Every implementation's request and result MUST still pass
 * the Port acceptance test {@link ReflectorRunOutcome} anchors: plain
 * serializable data, no `AbortSignal`, no PID/stream callbacks, no live
 * process handles — the same test `CodeIndex` (`ports/code-index/types.ts`)
 * and `VerifierPort` (`git/verify.ts`) apply.
 */

/**
 * Shared envelope every reflector's result carries: the raw provider text
 * and its exit code, alongside a kind-specific parsed payload. All four
 * reflector results extend this — `ReflectionResult` (`lib/reflector.ts`),
 * `DeepReflectionResult` (`lib/deep-reflector.ts`, shared by the arc- and
 * session-scoped kinds), and the failure reflector's outcome.
 */
export interface ReflectorRunOutcome {
  rawOutput: string
  exitCode: number
}

/** Discriminates the four reflector implementations registered in `registry.ts`. */
export type ReflectorKind = 'token' | 'deep-arc' | 'deep-session' | 'failure'

/**
 * The Reflector Port contract. Callers resolve an implementation via
 * `requireReflector(kind)` (`registry.ts`), never by importing
 * `runReflector` / `runDeepReflectorArc` / `runSessionReflector` /
 * `spawnFailureReflector` directly.
 */
export interface Reflector<TRequest, TResult extends ReflectorRunOutcome> {
  readonly kind: ReflectorKind
  reflect(request: TRequest): Promise<TResult>
}
