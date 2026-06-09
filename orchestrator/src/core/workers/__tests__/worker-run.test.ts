// Acceptance-criteria tests for Worker dispatch behaviour (slice 2/8 of
// PRD 948691d0). These verify that worker.run(prompt, { cwd }) produces a
// Session — an object with a claudeSessionId — and that the onEvent hook
// and message-cap accounting behave identically to a bare runClaudeCode call.
//
// The stub binary approach mirrors src/core/lib/__tests__/git.test.ts:
// a tiny Node script is placed on PATH so resolveClaudeBin() picks it up
// in place of the real `claude` CLI, making these tests hermetic.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Workers, createWorker, type WorkerConfig } from '..'
import type { ClaudeEvent } from '../../lib/claude-stream'

// ---------------------------------------------------------------------------
// Shared stub setup — emits 3 well-formed stream-json lines then exits 0.
// ---------------------------------------------------------------------------
describe('worker.run() — returns a Session identified by a claude session id', () => {
  let stubDir: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-worker-dispatch-stub-'))
    const stubPath = resolve(stubDir, 'claude')
    // Emits a minimal, valid stream-json conversation and exits 0.
    const stubScript = `#!/usr/bin/env node
const lines = [
  { type: 'system', subtype: 'init', session_id: 'worker-stub-session' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  { type: 'result', subtype: 'success', session_id: 'worker-stub-session' },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + '\\n');
`
    writeFileSync(stubPath, stubScript, 'utf8')
    chmodSync(stubPath, 0o755)
    originalPath = process.env.PATH
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
  })

  // Tracer bullet: the result of worker.run() carries the session id emitted
  // by the subprocess. This is the primary identity of a dispatched Session.
  it('result carries the session id from the subprocess', async () => {
    const r = await Workers.Coder.run('noop', {
      cwd: process.cwd(),
    })
    expect(r.exitCode).toBe(0)
    expect(r.sessionId).toBe('worker-stub-session')
  })

  // The result also carries the full conversation so callers can inspect the
  // exchange without having to collect events separately via onEvent.
  it('result carries the full conversation from the session', async () => {
    const r = await Workers.Coder.run('noop', {
      cwd: process.cwd(),
    })
    expect(r.conversation).toHaveLength(3)
    expect(r.conversation.map((e: ClaudeEvent) => e.type)).toEqual([
      'system',
      'assistant',
      'result',
    ])
  })
})

// ---------------------------------------------------------------------------
// Acceptance criterion 3: onEvent hook delivers every event in order.
// ---------------------------------------------------------------------------
describe('worker.run() — live event stream via onEvent', () => {
  let stubDir: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-worker-event-stub-'))
    const stubPath = resolve(stubDir, 'claude')
    const stubScript = `#!/usr/bin/env node
const lines = [
  { type: 'system', subtype: 'init', session_id: 'event-session' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'step 1' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'step 2' }] } },
  { type: 'result', subtype: 'success', session_id: 'event-session' },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + '\\n');
`
    writeFileSync(stubPath, stubScript, 'utf8')
    chmodSync(stubPath, 0o755)
    originalPath = process.env.PATH
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
  })

  it('onEvent receives every event in emission order', async () => {
    const seen: string[] = []
    await Workers.Coder.run('noop', {
      cwd: process.cwd(),
      onEvent: (event) => {
        seen.push(event.type)
      },
    })
    expect(seen).toEqual(['system', 'assistant', 'assistant', 'result'])
  })

  it('onEvent and result.conversation agree on the events received', async () => {
    const fromHook: string[] = []
    const r = await Workers.Coder.run('noop', {
      cwd: process.cwd(),
      onEvent: (event) => {
        fromHook.push(event.type)
      },
    })
    expect(fromHook).toEqual(r.conversation.map((e: ClaudeEvent) => e.type))
  })
})
