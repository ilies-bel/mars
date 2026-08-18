/**
 * Unit tests for {@link classifyCoderExitDisposition}.
 *
 * This is a pure function — no mocks, no filesystem, no DB.  Each test
 * constructs a {@link CoderRunOutcome} fixture and asserts on the returned
 * {@link CoderExitDisposition} discriminant.
 *
 * Coverage map (one test per acceptance-criteria bullet):
 *   1. aborted → terminal-operator-stop
 *   2. exit 138 + context-budget stderr → terminal-recovery
 *   3. quotaRejected → terminal-recovery
 *   4. SIGKILL/SIGTERM with zero messages → retryable-transient
 *   5. SIGKILL with prior messages exchanged → terminal-recovery
 *   6. exit 0 → success
 *
 * Additional branches covered:
 *   - SIGTERM with prior messages → terminal-recovery
 *   - Natural non-zero exit with messages → terminal-recovery
 *   - Natural non-zero exit with zero messages → retryable-transient
 *   - exit 138 WITHOUT context-budget phrase → NOT context-exhausted path
 */
import { describe, it, expect } from 'vitest'
import {
  classifyCoderExitDisposition,
  type CoderRunOutcome,
} from '../coder-exit'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CoderRunOutcome fixture.  Defaults produce a non-zero exit
 * with one message and no quota rejection so individual overrides are small.
 */
function makeOutcome(overrides: Partial<CoderRunOutcome> = {}): CoderRunOutcome {
  return {
    exitCode: 1,
    stderr: '',
    quotaRejected: null,
    conversation: [{}], // one message = coder reached provider
    ...overrides,
  }
}

const NOT_ABORTED = false
const ABORTED = true

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyCoderExitDisposition', () => {
  describe('terminal-operator-stop', () => {
    it('returns terminal-operator-stop when aborted=true, regardless of exit code', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 0 }),
        aborted: ABORTED,
      })
      expect(result.kind).toBe('terminal-operator-stop')
    })

    it('returns terminal-operator-stop when aborted=true with a non-zero exit', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 137, conversation: [] }),
        aborted: ABORTED,
      })
      expect(result.kind).toBe('terminal-operator-stop')
    })
  })

  describe('success', () => {
    it('returns success for exit 0 with no aborted signal', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 0 }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('success')
    })

    it('returns success for exit 0 even when quotaRejected is non-null (degenerate; quota path guarded by exitCode !== 0)', () => {
      // In practice, quotaRejected only appears alongside exitCode !== 0, but
      // the classifier checks exitCode === 0 first, so this resolves to success.
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 0, quotaRejected: { resetsAt: 9999 } }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('success')
    })
  })

  describe('terminal-recovery — context-budget-exhausted', () => {
    it('returns terminal-recovery when exit 138 and stderr contains "context budget exhausted"', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 138,
          stderr: 'some prefix\ncontext budget exhausted (maxContextTokens)\nsome suffix',
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('context-budget-exhausted')
    })

    it('does NOT classify as context-budget-exhausted when exit 138 but phrase is absent', () => {
      // Should fall through to the natural-exit path (zero-messages → retryable).
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 138,
          stderr: 'external cancel — unrelated reason',
          conversation: [],
        }),
        aborted: NOT_ABORTED,
      })
      // No context-budget phrase → retryable (zero messages).
      expect(result.kind).toBe('retryable-transient')
    })
  })

  describe('terminal-recovery — quota-rejected', () => {
    it('returns terminal-recovery when quotaRejected is non-null', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 1, quotaRejected: { resetsAt: 1_700_000_000 } }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('quota-rejected')
    })

    it('returns terminal-recovery for quota regardless of conversation length', () => {
      const resultWithMessages = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 1, quotaRejected: { resetsAt: 0 }, conversation: [{}, {}] }),
        aborted: NOT_ABORTED,
      })
      expect(resultWithMessages.kind).toBe('terminal-recovery')

      const resultNoMessages = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 1, quotaRejected: { resetsAt: 0 }, conversation: [] }),
        aborted: NOT_ABORTED,
      })
      expect(resultNoMessages.kind).toBe('terminal-recovery')
    })
  })

  describe('retryable-transient — SIGKILL/SIGTERM with zero messages', () => {
    it('returns retryable-transient for SIGKILL (exit 137) with zero messages', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 137, conversation: [] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('retryable-transient')
      if (result.kind !== 'retryable-transient') return
      expect(result.reason).toBe('sigkill-no-progress')
    })

    it('returns retryable-transient for SIGTERM (exit 143) with zero messages', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 143, conversation: [] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('retryable-transient')
      if (result.kind !== 'retryable-transient') return
      expect(result.reason).toBe('sigkill-no-progress')
    })
  })

  describe('terminal-recovery — SIGKILL/SIGTERM with prior progress', () => {
    it('returns terminal-recovery for SIGKILL (exit 137) with messages exchanged', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 137, conversation: [{ role: 'assistant' }, { role: 'user' }] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('killed-with-progress')
    })

    it('returns terminal-recovery for SIGTERM (exit 143) with messages exchanged', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 143, conversation: [{}] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('killed-with-progress')
    })
  })

  describe('retryable-transient — zero messages (non-signal exit)', () => {
    it('returns retryable-transient for a natural non-zero exit with zero messages', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 1, conversation: [] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('retryable-transient')
      if (result.kind !== 'retryable-transient') return
      expect(result.reason).toBe('zero-messages')
    })

    it('returns retryable-transient for exit 2 with zero messages', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 2, conversation: [] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('retryable-transient')
    })
  })

  describe('terminal-recovery — natural exit with messages', () => {
    it('returns terminal-recovery for a natural non-zero exit with messages', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 1, conversation: [{}] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('natural-exit')
    })

    it('returns terminal-recovery for exit 2 with messages', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 2, conversation: [{}, {}] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
    })
  })

  describe('priority ordering', () => {
    it('aborted beats context-exhausted (aborted checked first)', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 138, stderr: 'context budget exhausted' }),
        aborted: ABORTED,
      })
      expect(result.kind).toBe('terminal-operator-stop')
    })

    it('context-exhausted (exit 138) beats quota-rejected when both non-null', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 138,
          stderr: 'context budget exhausted',
          quotaRejected: { resetsAt: 0 },
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('context-budget-exhausted')
    })
  })
})
