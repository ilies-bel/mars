/**
 * `review-verifier.ts` — the `review` kind of the Verifier Port (ADR-0097).
 *
 * `review()` itself (worktree/dirty-main preflight, gate selection and
 * execution, fix-task dispatch, the LLM full-review path, the manual-QA
 * park) already has its own coverage via `verify-changes.test.ts` and the
 * workflow-level tests; this file is scoped to what `review-verifier.ts`
 * itself is responsible for:
 *
 *  1. it registers under the `review` kind at import time, alongside `local`
 *  2. its `run(args, ctx)` delegates to `review(ctx.ctx, args)` unchanged —
 *     `args` (a `ReviewOpts`) is the serializable half of the request, `ctx`
 *     (carrying `MarsCtx`) is the out-of-band half
 *  3. `run()` refuses to proceed without a `ctx` in its context argument,
 *     rather than passing `undefined` through to `review()`
 *  4. `runReview` (the `tools/index.ts` re-export's implementation) resolves
 *     `'review'` from the registry rather than closing over the module-local
 *     `reviewVerifier` constant, so a registry override is honoured
 *
 * `review()` is mocked out entirely so this suite never touches a real
 * worktree, task store, or worker.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockReview } = vi.hoisted(() => ({
  mockReview: vi.fn(),
}))

vi.mock('../../../../tools/verify/review', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../../tools/verify/review')>()
  return { ...orig, review: mockReview }
})

// ---------------------------------------------------------------------------

import { getVerifier, listVerifiers, registerVerifier, requireVerifier } from '../registry'
import { reviewVerifier, runReview, type ReviewVerifierContext } from '../review-verifier'
import type { ReviewOpts, ReviewResult } from '../../../../tools/verify/review'
import type { MarsCtx } from '../../../../tools/context'

// A stand-in for the real MarsCtx: `review-verifier.ts` never reaches into
// it (that's `review()`'s job, and `review()` is mocked), it only threads it
// through — so an opaque marker object is enough to prove identity.
const fakeCtx = { __fake: 'MarsCtx' } as unknown as MarsCtx

describe('built-in registration', () => {
  it('registers the review implementation at import time', () => {
    expect(listVerifiers().map((impl) => impl.kind)).toContain('review')
  })

  it('getVerifier resolves the built-in by kind', () => {
    expect(getVerifier('review')).toBe(reviewVerifier)
  })

  it('kind is exactly "review"', () => {
    expect(reviewVerifier.kind).toBe('review')
  })
})

describe('reviewVerifier.run()', () => {
  beforeEach(() => {
    mockReview.mockReset()
  })

  it('delegates to review(ctx, args) with the args and ctx unchanged', async () => {
    const opts: ReviewOpts = { reviewType: 'auto', integrationBranch: 'main' }
    const result: ReviewResult = { verified: true }
    mockReview.mockResolvedValueOnce(result)

    const runCtx: ReviewVerifierContext = { ctx: fakeCtx }
    await expect(reviewVerifier.run(opts, runCtx)).resolves.toBe(result)

    expect(mockReview).toHaveBeenCalledTimes(1)
    expect(mockReview).toHaveBeenCalledWith(fakeCtx, opts)
  })

  it('defaults to an empty ReviewOpts when the caller passes none through runReview', async () => {
    mockReview.mockResolvedValueOnce({ verified: true })
    await runReview(fakeCtx)
    expect(mockReview).toHaveBeenCalledWith(fakeCtx, {})
  })

  it('throws without calling review() when the run context has no ctx', async () => {
    await expect(reviewVerifier.run({ reviewType: 'auto' })).rejects.toThrow(/requires \{ ctx \}/)
    expect(mockReview).not.toHaveBeenCalled()
  })
})

describe('runReview()', () => {
  beforeEach(() => {
    mockReview.mockReset()
  })

  it('resolves the "review" kind from the registry rather than a fixed reference', async () => {
    const overrideResult: ReviewResult = { verified: true }
    const override = { kind: 'review', run: vi.fn().mockResolvedValue(overrideResult) }
    // `provide()`'s disposer only clears a key it still holds — registering
    // a second value under an already-used key (as this override does over
    // the self-registered `reviewVerifier`) does not restore the previous
    // value on dispose, it just removes the key (`ctx/registry.ts`'s
    // documented contract). Re-register `reviewVerifier` afterwards so this
    // test leaves the shared, module-level registry exactly as it found it.
    const dispose = registerVerifier(override)
    try {
      const opts: ReviewOpts = { reviewType: 'manual', guide: 'test' }
      await expect(runReview(fakeCtx, opts)).resolves.toBe(overrideResult)
      expect(override.run).toHaveBeenCalledWith(opts, { ctx: fakeCtx })
      // The real review() must not have run — the override took the call.
      expect(mockReview).not.toHaveBeenCalled()
    } finally {
      dispose()
      registerVerifier(reviewVerifier)
    }
    expect(requireVerifier('review')).toBe(reviewVerifier)
  })
})
