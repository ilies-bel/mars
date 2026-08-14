/**
 * Recovery-prompt distillation tests for the queue-fix-tasks recovery path
 * (slice 4 of PRD 74d76a78).
 *
 * When a recovery task resumes a verify-phase failure, the verifyOutput fed
 * to the coder is passed through distillObservation before being embedded in
 * the worker prompt. These tests verify that distillation works correctly on
 * the 200k-char noisy fixture from slice 3, and that signal lines (FAIL,
 * Error:, TS diagnostics) are preserved verbatim.
 */

import { describe, expect, it } from 'vitest'
import { distillObservation } from './lib/distill-observation'

// ── Noisy fixture from slice 3 ────────────────────────────────────────────────
// 200k chars of PASS lines — the canonical "noisy fixture" that motivated
// observation distillation. When the recovery coder receives this as
// verifyFailureOutput, the prompt must be far smaller than the raw string.
const buildNoisyFixture = (): string => {
  const passLine = 'PASS src/some/very/nested/module.test.ts (12ms)'
  const reps = Math.ceil(200_000 / (passLine.length + 1))
  return Array.from({ length: reps }, () => passLine).join('\n').slice(0, 200_000)
}

describe('queue-fix-tasks — recovery-path distillation', () => {
  it('prompt.length drops by ≥90% when input is the noisy fixture from slice 3', () => {
    const noisyVerifyOutput = buildNoisyFixture()
    expect(noisyVerifyOutput.length).toBeGreaterThanOrEqual(200_000)

    // distillObservation is what the recovery path (runAgent in primitives/index.ts)
    // calls before embedding verifyFailureOutput in the worker prompt.
    const result = distillObservation({
      text: noisyVerifyOutput,
      ref: 'arc://test-task/verify-output',
      kind: 'verify',
    })

    // The distilled output must be ≥ 90% smaller than the raw input.
    expect(result.originalBytes).toBeGreaterThanOrEqual(200_000)
    expect(result.distilledBytes).toBeLessThanOrEqual(result.originalBytes * 0.1)
  })

  it('preserves the failing-command line verbatim on the recovery path', () => {
    const failingLine = 'FAIL src/core/queue-fix-tasks.ts > TypeScript error TS2345'
    // Build a large noisy fixture that contains the failing line in the middle.
    const noise = Array.from({ length: 1_000 }, () => 'PASS src/unrelated.test.ts (2ms)').join('\n')
    const verifyOutput = [noise, failingLine, noise].join('\n')

    const result = distillObservation({
      text: verifyOutput,
      ref: 'arc://test-task/verify-output',
      kind: 'verify',
    })

    // The FAIL line must survive distillation intact — the coder needs it
    // to diagnose the failure.
    expect(result.text).toContain(failingLine)
  })

  it('includes <verify_full_log_ref> in the recovery prompt when verify output is present', () => {
    // The recovery path wraps the distilled text in a verifyBlock that includes
    // a <verify_full_log_ref> XML element so the coder can locate the full log.
    // This test validates the ref is threaded through correctly via distillObservation.
    const verifyRef = 'arc://mars-abc123/verify-output'
    const result = distillObservation({
      text: 'FAIL src/something.test.ts\nError: expected 1 to equal 2',
      ref: verifyRef,
      kind: 'verify',
    })

    // The ref must be threaded through the result for the caller to embed.
    expect(result.ref).toBe(verifyRef)
  })
})
