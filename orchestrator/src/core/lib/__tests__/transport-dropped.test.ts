/**
 * Tests for provider-transport-drop detection (2026-08-20 mars-8693f3a4
 * incident).
 *
 * The scenario: the Claude CLI's HTTP stream to the API was severed
 * mid-response. The CLI exits non-zero with EMPTY stderr, but the last
 * result/assistant text in the conversation reads:
 *   "API Error: Connection closed mid-response. The response above may be
 *    incomplete."
 * Because a message WAS exchanged (the error text itself lands as a
 * conversation entry), the pre-existing "zero messages exchanged" retry
 * heuristic missed it and the run was misclassified as a genuine coder
 * failure — burning the task's one recovery slot on a dropped socket four
 * times in a row across an entire arc.
 *
 * Required behaviour:
 * 1. `extractTransportDropped` is surfaced on the RunAgentResult parsed from
 *    those events (the provider adapter's own signal, not ad-hoc string
 *    matching downstream).
 * 2. `classifyCoderExitDisposition` treats it as `retryable-transient` — see
 *    `coder-exit-classifier.test.ts` for that layer's coverage.
 * 3. A run with no transport-drop signal (including a real error) leaves
 *    `transportDropped` false/undefined.
 *
 * Coverage split:
 *  - extractTransportDropped: pure-function unit tests (no IO).
 *  - runClaudeCode integration: stub `claude` binary emits the exact event
 *    sequence observed in the incident and exits 1; assert
 *    RunAgentResult.transportDropped is true.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { extractTransportDropped } from '../claude-stream'
import { runClaudeCode } from '../git/claude'
import type { ClaudeEvent } from '../claude-stream'

// ---------------------------------------------------------------------------
// Pure unit tests: extractTransportDropped
// ---------------------------------------------------------------------------

describe('extractTransportDropped', () => {
  it('returns false for an empty conversation', () => {
    expect(extractTransportDropped([])).toBe(false)
  })

  it('returns false for a normal successful conversation', () => {
    const conversation: ClaudeEvent[] = [
      { type: 'system', subtype: 'init', session_id: 'abc' },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done implementing.' }] },
      },
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]
    expect(extractTransportDropped(conversation)).toBe(false)
  })

  it('detects the phrase in a result event\'s result string', () => {
    const conversation: ClaudeEvent[] = [
      { type: 'system', subtype: 'init', session_id: 'abc' },
      {
        type: 'result',
        is_error: true,
        result: 'API Error: Connection closed mid-response. The response above may be incomplete.',
      },
    ]
    expect(extractTransportDropped(conversation)).toBe(true)
  })

  it('detects the phrase in a synthetic assistant message text block', () => {
    const conversation: ClaudeEvent[] = [
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: '<synthetic>',
          content: [
            {
              type: 'text',
              text: 'API Error: Connection closed mid-response. The response above may be incomplete.',
            },
          ],
        },
      },
    ]
    expect(extractTransportDropped(conversation)).toBe(true)
  })

  it('is case-insensitive', () => {
    const conversation: ClaudeEvent[] = [
      { type: 'result', is_error: true, result: 'connection CLOSED mid-response' },
    ]
    expect(extractTransportDropped(conversation)).toBe(true)
  })

  it('does not trigger on an unrelated error message', () => {
    const conversation: ClaudeEvent[] = [
      { type: 'result', is_error: true, result: 'SyntaxError: Unexpected token' },
    ]
    expect(extractTransportDropped(conversation)).toBe(false)
  })

  it('does not trigger on ConnectionRefused text (a different, already-handled signal)', () => {
    // ConnectionRefused (unreachable at connect time) is the pre-existing
    // api-unreachable / apiCircuitBreaker signal — a distinct failure mode
    // from a mid-stream drop. Must not collapse into the same detector.
    const conversation: ClaudeEvent[] = [
      { type: 'result', is_error: true, result: 'API Error: Unable to connect to API (ConnectionRefused)' },
    ]
    expect(extractTransportDropped(conversation)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration test: stub claude binary emitting the observed drop sequence
// ---------------------------------------------------------------------------

/**
 * Write a stub `claude` binary that emits:
 * 1. system/init
 * 2. result with is_error:true and the exact "Connection closed mid-response"
 *    text observed in the mars-8693f3a4 incident
 * Then exits with code 1, writing nothing to stderr — matching the incident's
 * "stderr empty; last stream text: API Error: Connection closed mid-response"
 * diagnostic exactly.
 */
const writeTransportDropStub = (stubDir: string, sessionId: string): void => {
  const stubPath = resolve(stubDir, 'claude')
  const stubScript = `#!/usr/bin/env node
const sessionId = ${JSON.stringify(sessionId)};
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  result: 'API Error: Connection closed mid-response. The response above may be incomplete.',
  session_id: sessionId,
}) + '\\n');
// No stderr output — matches the incident's "stderr empty" diagnostic.
process.exit(1);
`
  writeFileSync(stubPath, stubScript, 'utf8')
  chmodSync(stubPath, 0o755)
}

describe('runClaudeCode — provider transport-drop event sequence', () => {
  let stubDir: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-transport-drop-stub-'))
    originalPath = process.env.PATH
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
  })

  it('surfaces transportDropped=true on the exact incident event sequence', async () => {
    writeTransportDropStub(stubDir, 'transport-drop-session')

    const r = await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    // The stub exits non-zero with no stderr — the incident's exact shape.
    expect(r.exitCode).toBe(1)
    expect(r.stderr.trim()).toBe('')
    expect(r.transportDropped).toBe(true)
  }, 15_000)

  it('transportDropped is false for a normal zero-exit run', async () => {
    const stubPath = resolve(stubDir, 'claude')
    writeFileSync(
      stubPath,
      `#!/usr/bin/env node
const sessionId = 'ok-session';
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: sessionId }) + '\\n');
process.exit(0);
`,
      'utf8',
    )
    chmodSync(stubPath, 0o755)

    const r = await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    expect(r.exitCode).toBe(0)
    expect(r.transportDropped).toBe(false)
  }, 15_000)
})
