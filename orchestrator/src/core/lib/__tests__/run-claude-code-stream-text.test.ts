/**
 * Regression test for the empty-stderr fallback path.
 *
 * When the claude CLI exits non-zero due to an API-level rejection (e.g.
 * monthly spend limit) it writes NOTHING to stderr — the human-readable cause
 * arrives as a `result` event in the stdout JSONL stream. This test verifies
 * that the conversation captures that event so `extractLastStreamText` can
 * surface it for the task `error` / `errorOutput` fields.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runClaudeCode } from '../git/claude'
import { extractLastStreamText } from '../claude-stream'
import { computeFailureSignature } from '../failure-signature'

// Stub that mimics an API-level rejection:
// • emits a system/init event (session established)
// • emits a result event with is_error:true and a human-readable message
// • writes NOTHING to stderr
// • exits with code 1
const writeApiRejectionStub = (stubDir: string, sessionId: string, errorMsg: string): void => {
  const stubPath = resolve(stubDir, 'claude')
  const stubScript = `#!/usr/bin/env node
const sessionId = ${JSON.stringify(sessionId)};
const errorMsg = ${JSON.stringify(errorMsg)};
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'error_api_error',
  is_error: true,
  result: errorMsg,
  session_id: sessionId,
}) + '\\n');
// No stderr output — the real claude CLI behaves this way on spend-limit rejections.
process.exit(1);
`
  writeFileSync(stubPath, stubScript, 'utf8')
  chmodSync(stubPath, 0o755)
}

describe('runClaudeCode — empty stderr with result event (API-rejection path)', () => {
  let stubDir: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-stream-text-stub-'))
    originalPath = process.env.PATH
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
  })

  it('captures the result event text in conversation when stderr is empty', async () => {
    const errorMsg = "You've hit your monthly spend limit. Please wait or upgrade your plan."
    writeApiRejectionStub(stubDir, 'api-rejection-session', errorMsg)

    const r = await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    // The stub exits non-zero with no stderr.
    expect(r.exitCode).toBe(1)
    expect(r.stderr.trim()).toBe('')

    // The conversation must contain the result event so operators can diagnose
    // the cause without reading raw transcript files.
    const resultEvent = r.conversation.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
    expect(resultEvent?.result).toBe(errorMsg)

    // extractLastStreamText surfaces the message for task.error / errorOutput.
    const lastText = extractLastStreamText(r.conversation)
    expect(lastText).toBe(errorMsg)
  }, 15_000)

  it('nonzero exit with empty stderr builds diagText from last stream text', async () => {
    const errorMsg = 'API rate limit exceeded. Retry after 60 seconds.'
    writeApiRejectionStub(stubDir, 'rate-limit-session', errorMsg)

    const r = await runClaudeCode({ cwd: process.cwd(), prompt: 'noop' })

    expect(r.exitCode).toBe(1)
    expect(r.stderr.trim()).toBe('')

    // Simulate what the nonzero-exit handler in primitives/index.ts builds.
    const stderrTail = r.stderr.trim().slice(-1000)
    const streamText = extractLastStreamText(r.conversation)
    const diagText =
      stderrTail.length > 0
        ? `stderr tail:\n${stderrTail}`
        : streamText
          ? `stderr empty; last stream text:\n${streamText.slice(-500)}`
          : `stderr empty; no stream text captured`

    // The task error must contain the human-readable cause, not empty content.
    expect(diagText).toContain('stderr empty; last stream text:')
    expect(diagText).toContain(errorMsg)
  }, 15_000)

  // Regression: `claude -p ''` reads the prompt from stdin, which is
  // /dev/null for dispatched workers — the CLI reads EOF and exits non-zero
  // with no diagnostic. Refuse before spawning so the failure arrives named.
  it.each([
    ['empty string', ''],
    ['whitespace only', '  \n\t '],
  ])('refuses to spawn claude for a %s prompt', async (_label, prompt) => {
    const r = await runClaudeCode({ cwd: process.cwd(), prompt })

    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/refusing to spawn claude with an empty prompt/i)
    expect(r.conversation).toEqual([])
    expect(computeFailureSignature('code:coder-exit-nonzero', r.stderr)).toBe(
      'code:coder-exit-nonzero/empty-prompt',
    )
  })
})
