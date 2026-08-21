/**
 * `review` Verifier implementation — the `review` workflow primitive
 * (`../../../tools/verify/review.ts`: worktree/dirty-main preflight, gate
 * selection *and* execution, fix-task dispatch on failure, the LLM
 * full-review path, and the manual-QA park) exposed behind the Verifier Port
 * (ADR-0097) as a second, distinct kind alongside `local` (the gate-execution
 * level `registry.ts` already wires up).
 *
 * Unlike `local` — one of N interchangeable subprocess runners selected by
 * `MARS_VERIFIER_KIND` — `review` is a structurally-unrelated contract that a
 * caller resolves by name (`requireVerifier<ReviewOpts, ReviewResult,
 * ReviewVerifierContext>('review')`), the same way each of the four
 * `Reflector` kinds is looked up directly rather than through env-driven
 * resolution (`../reflector/types.ts`).
 *
 * The Port split mirrors `local-subprocess.ts`: the serializable half of the
 * request is {@link ReviewOpts} (plain data — no functions, no live
 * handles), and the in-process-only half (`MarsCtx`, carrying the task
 * store, worker plumbing, and trace context) travels out of band as
 * {@link ReviewVerifierContext} — `local`'s equivalent out-of-band extras are
 * `traceCtx`/`signal`/`onChildPid` on `VerifierRunContext`.
 *
 * This module — not `tools/index.ts` — is the one place allowed to import
 * `tools/verify/review.ts` directly; every other caller resolves `review`
 * through this Port (`registerVerifier`/`requireVerifier`), never by
 * importing the primitive module itself.
 *
 * Self-registers as a side effect of importing this module, deliberately
 * *not* from `registry.ts` — see that module's doc comment for why folding
 * this self-registration into `registry.ts` would create an import cycle
 * (`review` primitive → `registry.ts` for its own nested `local` gate run).
 */
import { review, type ReviewOpts, type ReviewResult } from '../../../tools/verify/review'
import type { MarsCtx } from '../../../tools/context'
import { registerVerifier, requireVerifier } from './registry'
import type { Verifier } from './types'

export type { ReviewOpts, ReviewResult, VerifyGateOutcome } from '../../../tools/verify/review'

/**
 * In-process-only extras the `review` kind needs: the full workflow `ctx`
 * (services/store/worker plumbing) the `review` primitive was written
 * against. Analogous to `local`'s `VerifierRunContext`.
 */
export interface ReviewVerifierContext {
  ctx: MarsCtx
}

export const reviewVerifier: Verifier<ReviewOpts, ReviewResult, ReviewVerifierContext> = {
  kind: 'review',
  async run(args: ReviewOpts, runCtx?: ReviewVerifierContext): Promise<ReviewResult> {
    if (!runCtx?.ctx) {
      throw new Error("verifier 'review': run() requires { ctx } (MarsCtx) as its context argument")
    }
    return review(runCtx.ctx, args)
  },
}

/**
 * Convenience wrapper for the primitive-authoring surface (`tools/index.ts`):
 * resolves the `review` kind from the registry (not the module-local
 * `reviewVerifier` constant, so a test override registered under `'review'`
 * is honoured) and runs it with `ctx` threaded through as the out-of-band
 * context — callers keep the original `review(ctx, opts)` call shape without
 * importing the primitive module directly.
 */
export const runReview = (ctx: MarsCtx, opts: ReviewOpts = {}): Promise<ReviewResult> =>
  requireVerifier<ReviewOpts, ReviewResult, ReviewVerifierContext>('review').run(opts, { ctx })

// Self-registers at import time (see module doc for why this happens here
// rather than in `registry.ts`).
registerVerifier(reviewVerifier)
