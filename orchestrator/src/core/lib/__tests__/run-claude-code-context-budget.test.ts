import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runClaudeCode } from '../git/claude'

// Stub that emits assistant events with growing usage.input_tokens so the
// context budget guard fires without needing a real Claude session.
// Each event carries: { input_tokens: (i+1) * 100 } so that at event 8
// (i=7) input_tokens=800 (crosses 80% of 1000), and at event 10 (i=9)
// input_tokens=1000 (crosses the budget and triggers abort).
const writeContextStub = (stubDir: string, sessionId: string): void => {
  const stubPath = resolve(stubDir, 'claude')
  const stubScript = `#!/usr/bin/env node
const sessionId = ${JSON.stringify(sessionId)};
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
let i = 0;
const tick = () => {
  if (i >= 20) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId }) + '\\n');
    process.exit(0);
    return;
  }
  const inputTokens = (i + 1) * 100;
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'msg' + i }],
      usage: { input_tokens: inputTokens, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
  }) + '\\n');
  i++;
  setTimeout(tick, 5);
};
tick();
`
  writeFileSync(stubPath, stubScript, 'utf8')
  chmodSync(stubPath, 0o755)
}

describe('runClaudeCode context budget guard', () => {
  let stubDir: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-ctx-stub-'))
    originalPath = process.env.PATH
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
  })

  it('aborts with exitCode 138 and context-exhaustion stderr when budget is crossed', async () => {
    writeContextStub(stubDir, 'ctx-session-kill')
    // budget=1000: events with input_tokens>=1000 (event 10, i=9) trigger kill
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 30_000,
      maxContextTokens: 1000,
    })

    expect(r.exitCode).toBe(138)
    expect(r.stderr).toContain('context budget exhausted')
    expect(r.stderr).not.toContain('read/grep span watcher')
  }, 30_000)

  it('stderr includes the token count and budget in the context-exhaustion message', async () => {
    writeContextStub(stubDir, 'ctx-session-stderr')
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 30_000,
      maxContextTokens: 1000,
    })

    expect(r.exitCode).toBe(138)
    expect(r.stderr).toMatch(/context budget exhausted \(\d+\/1000 tokens\)/)
  }, 30_000)

  it('emits exactly one console.warn at the 80% threshold', async () => {
    writeContextStub(stubDir, 'ctx-session-warn')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 30_000,
      maxContextTokens: 1000,
    })

    const contextWarnCalls = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('crossed 80% warn'),
    )
    warnSpy.mockRestore()

    // Exactly one 80%-warn line, not repeated.
    expect(contextWarnCalls).toHaveLength(1)
    // The warn line should mention the session, context size, threshold, and budget.
    expect(String(contextWarnCalls[0][0])).toMatch(/context at \d+ tokens crossed 80% warn \(\d+\/1000\)/)
  }, 30_000)

  it('runs to completion without aborting when maxContextTokens is 0 (disabled)', async () => {
    writeContextStub(stubDir, 'ctx-session-disabled')
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 30_000,
      maxContextTokens: 0,
    })

    // Should complete naturally (exit 0), not be killed by the context budget.
    expect(r.exitCode).toBe(0)
    expect(r.stderr ?? '').not.toContain('context budget exhausted')
  }, 30_000)

  it('context-exhaustion stderr is distinguishable from span-watcher stderr', async () => {
    writeContextStub(stubDir, 'ctx-session-distinguish')
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 30_000,
      maxContextTokens: 1000,
    })

    // The context-exhaustion stderr must NOT match the span-watcher string so
    // implement-workflow.ts can route them to different failure reasons.
    expect(r.stderr).not.toBe('claude -p aborted by caller (read/grep span watcher)')
    expect(r.stderr).toContain('context budget exhausted')
  }, 30_000)
})
