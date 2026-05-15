import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runClaudeCode } from '../git'

// Stub that, on each tick, writes a sentinel file in `markerDir` and then
// keeps ticking. If the wrapper's timeout fires WITHOUT killing the child,
// the stub continues writing sentinels after `runClaudeCode` resolves —
// which is the exact `verify:has-diff/no-commits-ahead` failure mode in
// production (Claude lands a commit after verify has already run).
const writeTimeoutStub = (
  stubDir: string,
  markerDir: string,
  sessionId: string,
): void => {
  const stubPath = resolve(stubDir, 'claude')
  const stubScript = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const sessionId = ${JSON.stringify(sessionId)};
const markerDir = ${JSON.stringify(markerDir)};
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\\n');
let i = 0;
const tick = () => {
  // Each tick writes a numbered marker file. The test inspects the
  // marker count BEFORE and AFTER the wait window to confirm the child
  // stopped producing side effects once runClaudeCode returned.
  try { fs.writeFileSync(path.join(markerDir, 'm-' + i), String(Date.now())); } catch {}
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'm' + i }] } }) + '\\n');
  i += 1;
  setTimeout(tick, 20);
};
tick();
// Long-lived. The wrapper must SIGKILL us on timeout.
`
  writeFileSync(stubPath, stubScript, 'utf8')
  chmodSync(stubPath, 0o755)
}

describe('runClaudeCode timeout aborts the subprocess', () => {
  let stubDir: string
  let markerDir: string
  let originalPath: string | undefined
  let originalCap: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-timeout-stub-'))
    markerDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-timeout-marker-'))
    originalPath = process.env.PATH
    originalCap = process.env.MARS_CLAUDE_MAX_MESSAGES
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
    // Disable the message cap so the wall-clock timeout is the only abort
    // path — otherwise the stub would trip the 100-event cap first and we
    // wouldn't be exercising the right code path.
    process.env.MARS_CLAUDE_MAX_MESSAGES = '0'
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    if (originalCap === undefined) delete process.env.MARS_CLAUDE_MAX_MESSAGES
    else process.env.MARS_CLAUDE_MAX_MESSAGES = originalCap
    rmSync(stubDir, { recursive: true, force: true })
    rmSync(markerDir, { recursive: true, force: true })
  })

  it('returns exit 124 and stops the subprocess before resolving', async () => {
    writeTimeoutStub(stubDir, markerDir, 'timeout-session')
    const start = Date.now()
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 500,
    })
    const elapsed = Date.now() - start
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain('timed out after 500ms')
    expect(r.sessionId).toBe('timeout-session')
    // The wrapper must drain the child before resolving — racing a timeout
    // payload against a still-running subprocess is the verify:has-diff
    // ghost-commit failure mode this test exists to catch.
    expect(elapsed).toBeGreaterThanOrEqual(500)

    // Snapshot the marker count right after runClaudeCode returns. If the
    // subprocess was killed (the fix), the count must remain stable while
    // we sleep. If the timeout merely resolved the wrapper and left the
    // child alive (the bug), more markers will appear.
    const countMarkers = (): number =>
      existsSync(markerDir)
        ? require('node:fs').readdirSync(markerDir).length
        : 0
    const before = countMarkers()
    await new Promise((res) => setTimeout(res, 250))
    const after = countMarkers()
    expect(after).toBe(before)
  }, 15_000)
})
