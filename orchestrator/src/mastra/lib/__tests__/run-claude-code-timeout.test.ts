import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runClaudeCode } from '../git'

// The wrapper's wall-clock timeout uses `timeoutMs` from the moment
// `runClaudeCode` is called. The previous incarnation of this test set
// `timeoutMs: 500`, which left almost no headroom for Node cold-starting
// the stub under parallel vitest load: on a busy machine spawn-up of the
// stub sometimes exceeded 500ms, so the SIGKILL fired before the stub
// emitted its 'system/init' line and `sessionId` came back null. It
// passed solo (~760ms) but flaked in the full 414-test run.
//
// Fix: give the timeout path 1500ms (3x the old window) so a cold-start
// stub has ~1s of slack to announce its session id before the kill,
// while still exercising the timeout/drain semantics. Belt-and-braces, a
// `beforeAll` warmup spawns the stub once and waits for its first on-disk
// marker, proving the binary is alive and priming OS/Node caches so the
// timed run in the test body is not a cold start.
const TIMEOUT_MS = 1500

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

// Spawn the stub directly once and wait until it writes its first marker.
// This proves the stub binary runs, and primes OS/Node startup caches so
// the timed `runClaudeCode` call in the test is not racing a cold spawn
// against the timeout window.
const warmUpStub = async (
  stubDir: string,
  warmupMarkerDir: string,
): Promise<void> => {
  const child = spawn(resolve(stubDir, 'claude'), [], {
    stdio: 'ignore',
    env: { ...process.env },
  })
  try {
    const deadline = Date.now() + 5_000
    while (
      !(existsSync(warmupMarkerDir) && readdirSync(warmupMarkerDir).length > 0)
    ) {
      if (Date.now() > deadline) {
        throw new Error('timeout stub failed to produce a marker during warmup')
      }
      await new Promise((res) => setTimeout(res, 10))
    }
  } finally {
    const exited = new Promise<void>((res) => child.once('exit', () => res()))
    child.kill('SIGKILL')
    await exited
  }
}

describe('runClaudeCode timeout aborts the subprocess', () => {
  let stubDir: string
  let markerDir: string
  let originalPath: string | undefined
  let originalCap: string | undefined

  beforeAll(async () => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-timeout-stub-'))
    markerDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-timeout-marker-'))
    originalPath = process.env.PATH
    originalCap = process.env.MARS_CLAUDE_MAX_MESSAGES
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
    // Disable the message cap so the wall-clock timeout is the only abort
    // path — otherwise the stub would trip the 100-event cap first and we
    // wouldn't be exercising the right code path.
    process.env.MARS_CLAUDE_MAX_MESSAGES = '0'

    // Warm up against a throwaway marker dir, then start the real test
    // from a clean markerDir so the before/after marker count is exact.
    const warmupMarkerDir = mkdtempSync(
      resolve(tmpdir(), 'mars-claude-timeout-warmup-'),
    )
    writeTimeoutStub(stubDir, warmupMarkerDir, 'warmup-session')
    try {
      await warmUpStub(stubDir, warmupMarkerDir)
    } finally {
      rmSync(warmupMarkerDir, { recursive: true, force: true })
    }
    // Reset markerDir and install the real stub for the timed run.
    rmSync(markerDir, { recursive: true, force: true })
    mkdirSync(markerDir, { recursive: true })
    writeTimeoutStub(stubDir, markerDir, 'timeout-session')
  }, 20_000)

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    if (originalCap === undefined) delete process.env.MARS_CLAUDE_MAX_MESSAGES
    else process.env.MARS_CLAUDE_MAX_MESSAGES = originalCap
    rmSync(stubDir, { recursive: true, force: true })
    rmSync(markerDir, { recursive: true, force: true })
  })

  it('returns exit 124 and stops the subprocess before resolving', async () => {
    const start = Date.now()
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: TIMEOUT_MS,
    })
    const elapsed = Date.now() - start
    expect(r.exitCode).toBe(124)
    expect(r.stderr).toContain(`timed out after ${TIMEOUT_MS}ms`)
    expect(r.sessionId).toBe('timeout-session')
    // The wrapper must drain the child before resolving — racing a timeout
    // payload against a still-running subprocess is the verify:has-diff
    // ghost-commit failure mode this test exists to catch.
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS)

    // Snapshot the marker count right after runClaudeCode returns. If the
    // subprocess was killed (the fix), the count must remain stable while
    // we sleep. If the timeout merely resolved the wrapper and left the
    // child alive (the bug), more markers will appear.
    const countMarkers = (): number =>
      existsSync(markerDir) ? readdirSync(markerDir).length : 0
    const before = countMarkers()
    await new Promise((res) => setTimeout(res, 250))
    const after = countMarkers()
    expect(after).toBe(before)
  }, 20_000)
})
