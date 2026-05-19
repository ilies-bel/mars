import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runClaudeCode } from '../git'

const writeStub = (stubDir: string, eventCount: number, sessionId: string) => {
  const stubPath = resolve(stubDir, 'claude')
  // Stub emits `eventCount` assistant events, then a final result event,
  // sleeping briefly between batches so a SIGKILL can short-circuit it.
  const stubScript = `#!/usr/bin/env node
const eventCount = ${eventCount};
const sessionId = ${JSON.stringify(sessionId)};
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
let i = 0;
const tick = () => {
  if (i >= eventCount) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sessionId }) + '\\n');
    process.exit(0);
    return;
  }
  // Emit a small batch per tick to keep the stream visible to the parent.
  for (let k = 0; k < 10 && i < eventCount; k++, i++) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'm' + i }] } }) + '\\n');
  }
  setTimeout(tick, 5);
};
tick();
// Honour SIGTERM/SIGKILL — node will exit by default; nothing extra needed.
`
  writeFileSync(stubPath, stubScript, 'utf8')
  chmodSync(stubPath, 0o755)
}

describe('runClaudeCode message cap', () => {
  let stubDir: string
  let originalPath: string | undefined
  let originalCap: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-cap-stub-'))
    originalPath = process.env.PATH
    originalCap = process.env.MARS_CLAUDE_MAX_MESSAGES
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    if (originalCap === undefined) delete process.env.MARS_CLAUDE_MAX_MESSAGES
    else process.env.MARS_CLAUDE_MAX_MESSAGES = originalCap
    rmSync(stubDir, { recursive: true, force: true })
  })

  it('hits the default 100-message cap and resolves with exit 137', async () => {
    delete process.env.MARS_CLAUDE_MAX_MESSAGES
    // 500 assistant events plus the system+result framing — far above 100.
    writeStub(stubDir, 500, 'cap-session-default')

    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 30_000,
    })

    expect(r.exitCode).toBe(137)
    expect(r.stderr).toBe(
      'claude -p hit message cap of 100 (MARS_CLAUDE_MAX_MESSAGES)',
    )
    expect(r.conversation.length).toBe(100)
    expect(r.sessionId).toBe('cap-session-default')
  }, 30_000)

  it('respects a custom cap from MARS_CLAUDE_MAX_MESSAGES', async () => {
    process.env.MARS_CLAUDE_MAX_MESSAGES = '25'
    writeStub(stubDir, 200, 'cap-session-custom')

    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 30_000,
    })

    expect(r.exitCode).toBe(137)
    expect(r.stderr).toBe(
      'claude -p hit message cap of 25 (MARS_CLAUDE_MAX_MESSAGES)',
    )
    expect(r.conversation.length).toBe(25)
  }, 30_000)

  it('runs to natural completion when MARS_CLAUDE_MAX_MESSAGES=0 disables the cap', async () => {
    process.env.MARS_CLAUDE_MAX_MESSAGES = '0'
    writeStub(stubDir, 200, 'cap-session-disabled')

    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 30_000,
    })

    expect(r.exitCode).toBe(0)
    // 1 system + 200 assistant + 1 result.
    expect(r.conversation.length).toBe(202)
    expect(r.sessionId).toBe('cap-session-disabled')
  }, 30_000)
})
