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
 *   - transportDropped=true → retryable-transient regardless of exit code or
 *     message count (2026-08-20 mars-8693f3a4 incident: a dropped provider
 *     connection was misclassified as a genuine coder failure because the
 *     CLI's own "connection closed" text landed as a conversation entry,
 *     defeating the zero-messages heuristic)
 *   - a genuine non-zero exit with real stderr and no transport signal still
 *     classifies as terminal-recovery (unaffected by the new rule)
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

  describe('retryable-transient — provider transport dropped', () => {
    it('returns retryable-transient when transportDropped=true, even with messages exchanged', () => {
      // The CLI's own "Connection closed mid-response" text can itself land
      // as a conversation entry, so messageCount > 0 here — the exact shape
      // that defeated the zero-messages heuristic in the 2026-08-20 incident.
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 1, conversation: [{}], transportDropped: true }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('retryable-transient')
      if (result.kind !== 'retryable-transient') return
      expect(result.reason).toBe('provider-transport-dropped')
    })

    it('returns retryable-transient for transportDropped=true regardless of exit code (SIGTERM)', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 143, conversation: [{}, {}], transportDropped: true }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('retryable-transient')
      if (result.kind !== 'retryable-transient') return
      expect(result.reason).toBe('provider-transport-dropped')
    })

    it('transportDropped beats natural-exit (checked before the message-count rules)', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 1, conversation: [{}, {}, {}], transportDropped: true }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('retryable-transient')
    })

    it('does NOT trigger when transportDropped is absent (undefined) — falls through to natural-exit', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({ exitCode: 1, conversation: [{}] }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('natural-exit')
    })

    it('a genuine coder failure with real stderr and no transport signal still classifies as terminal-recovery', () => {
      // Requirement: transportDropped must not blur genuine coder failures —
      // a real error (e.g. a syntax error the coder introduced) with no
      // transport signal still spends the recovery attempt exactly as today.
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: 'SyntaxError: Unexpected token in src/foo.ts:12',
          conversation: [{}, {}],
          transportDropped: false,
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('natural-exit')
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

  // ---------------------------------------------------------------------------
  // Regression: 2026-09-03 DNS-outage incident (8 tasks burned recovery budget)
  // ---------------------------------------------------------------------------
  //
  // A DNS outage caused every coder running at the time to exhaust its 10 API
  // retries and exit 1. Each was classified as `code:coder-exit-nonzero`,
  // spawned a fix-task (consuming its single recovery slot), and the fix-tasks
  // died the same way — leaving 8 origins permanently failed with no remaining
  // recovery budget and nothing wrong with their code.
  //
  // The fix: classify API-connectivity failures as `terminal-env-unreachable`
  // so classifyCoderExit re-queues without touching the fix-task budget.
  describe('terminal-env-unreachable — API connectivity failures', () => {
    it('classifies ENOTFOUND in stderr as terminal-env-unreachable (2026-09-03 regression)', () => {
      // The exact shape that burned 8 recovery slots: the Claude CLI's own
      // "API Error: Unable to connect to API (ENOTFOUND)" appears in stderr
      // after exhausting its api_retry budget.
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: 'API Error: Unable to connect to API (ENOTFOUND api.anthropic.com)',
          conversation: [{}], // one message — the natural-exit rule would fire here without the fix
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-env-unreachable')
      if (result.kind !== 'terminal-env-unreachable') return
      expect(result.reason).toBe('api-unreachable')
    })

    it('classifies ECONNREFUSED in stderr as terminal-env-unreachable', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: 'Error: connect ECONNREFUSED 127.0.0.1:443',
          conversation: [{}],
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-env-unreachable')
    })

    it('classifies EAI_AGAIN in stderr as terminal-env-unreachable', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: 'getaddrinfo EAI_AGAIN api.anthropic.com',
          conversation: [],
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-env-unreachable')
    })

    it('classifies api_retry@max_retries in the event stream as terminal-env-unreachable', () => {
      // The exact event shape from the 2026-09-03 incident log:
      //   {"type":"system","subtype":"api_retry","attempt":10,"max_retries":10,...}
      // This appears in the conversation (event stream) after the CLI exhausts
      // its own retry budget. Without the fix, a non-zero exit with messages
      // would classify as `natural-exit` (terminal-recovery).
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: '',
          conversation: [
            { type: 'system', subtype: 'api_retry', attempt: 10, max_retries: 10 },
            { type: 'result', is_error: true },
          ],
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-env-unreachable')
      if (result.kind !== 'terminal-env-unreachable') return
      expect(result.reason).toBe('api-unreachable')
    })

    it('classifies terminal_reason:api_error in the event stream as terminal-env-unreachable', () => {
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: '',
          conversation: [
            { type: 'result', is_error: true, terminal_reason: 'api_error' },
          ],
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-env-unreachable')
    })

    it('classifies explicit apiUnreachable=true as terminal-env-unreachable', () => {
      // Callers that pre-compute the flag (e.g. after parsing stdout JSON) can
      // set it explicitly without pattern-matching stderr or conversation.
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: '',
          conversation: [],
          apiUnreachable: true,
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-env-unreachable')
    })

    it('does NOT classify a genuine code failure as terminal-env-unreachable', () => {
      // A real coder failure (non-zero exit, real conversation, no connectivity
      // signals) must still route to fix-task recovery, unaffected by the fix.
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: 'TypeError: Cannot read properties of undefined (reading "id")',
          conversation: [{}, {}, {}],
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-recovery')
      if (result.kind !== 'terminal-recovery') return
      expect(result.reason).toBe('natural-exit')
    })

    it('does NOT classify a partial api_retry (below max_retries) as unreachable', () => {
      // api_retry events at attempt < max_retries are mid-flight retries, not
      // exhaustion — the CLI may still succeed on a subsequent attempt.
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 0,
          stderr: '',
          conversation: [
            { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10 },
          ],
        }),
        aborted: NOT_ABORTED,
      })
      // Exit 0 → success; the api_retry is not exhausted
      expect(result.kind).toBe('success')
    })

    it('terminal-env-unreachable beats natural-exit when ENOTFOUND appears in result text', () => {
      // The ENOTFOUND string can also appear in a result event's text field;
      // the classifier should catch it there too.
      const result = classifyCoderExitDisposition({
        r: makeOutcome({
          exitCode: 1,
          stderr: '',
          conversation: [
            { type: 'result', is_error: true, result: 'API Error: Unable to connect to API (ENOTFOUND)' },
          ],
        }),
        aborted: NOT_ABORTED,
      })
      expect(result.kind).toBe('terminal-env-unreachable')
    })
  })
})
