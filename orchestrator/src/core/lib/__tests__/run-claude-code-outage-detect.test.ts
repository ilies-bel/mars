import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runClaudeCode } from '../git/claude'
import { apiCircuitBreaker } from '../api-circuit-breaker'

// Write a stub claude binary that emits a fixed sequence of NDJSON lines
// to stdout and exits. Two call sites below so this helper is justified.
function writeNdjsonStub(dir: string, events: object[]): void {
  const script = `#!/usr/bin/env node
const lines = ${JSON.stringify(events)};
for (const line of lines) {
  process.stdout.write(JSON.stringify(line) + '\\n');
}
`
  const p = resolve(dir, 'claude')
  writeFileSync(p, script, 'utf8')
  chmodSync(p, 0o755)
}

describe('runClaudeCode — API outage detection', () => {
  let stubDir: string
  let originalPath: string | undefined

  beforeEach(() => {
    // Ensure the breaker is closed before each test so they are independent.
    apiCircuitBreaker.close()
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-outage-detect-'))
    originalPath = process.env.PATH
    // Prepend stubDir so resolveClaudeBin() picks up our stub first.
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
    apiCircuitBreaker.close()
  })

  it('opens the breaker and sets a ConnectionRefused reason when >= 3 api_retry events fire', async () => {
    // Emit 3 api_retry events followed by a synthetic terminal, which is the
    // canonical ConnectionRefused cascade pattern.
    writeNdjsonStub(stubDir, [
      { type: 'system', subtype: 'init', session_id: 'outage-session' },
      { type: 'api_retry', attempt: 1 },
      { type: 'api_retry', attempt: 2 },
      { type: 'api_retry', attempt: 3 },
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
              text: 'ConnectionRefused: connect ECONNREFUSED 127.0.0.1:443',
            },
          ],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: 'result',
        is_error: true,
        api_error_status: 'ECONNREFUSED',
        result: 'ConnectionRefused',
      },
    ])

    await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    expect(apiCircuitBreaker.isOpen()).toBe(true)
    expect(apiCircuitBreaker.state().reason).toContain('ConnectionRefused')
  })

  it('does not open the breaker on a normal successful run', async () => {
    writeNdjsonStub(stubDir, [
      { type: 'system', subtype: 'init', session_id: 'ok-session' },
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
      {
        type: 'result',
        is_error: false,
        result: 'Done',
        duration_ms: 100,
        total_cost_usd: 0.001,
      },
    ])

    await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    expect(apiCircuitBreaker.isOpen()).toBe(false)
  })
})
