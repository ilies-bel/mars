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
import type { WorkerConfig } from '..'
import type { ClaudeEvent } from '../../lib/claude-stream'

// This suite exercises Claude-specific session-id behaviour. Pin its provider
// explicitly now that the framework-wide default is Codex.
const originalProvider = process.env.MARS_WORKER_PROVIDER
process.env.MARS_WORKER_PROVIDER = 'claude'
const { Workers, createWorker } = await import('..')

afterAll(() => {
  if (originalProvider === undefined) delete process.env.MARS_WORKER_PROVIDER
  else process.env.MARS_WORKER_PROVIDER = originalProvider
})

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
// Per-step model override (Agent-SDK parity). runAgent(ctx, { model }) rebuilds
// the resolved Worker via createWorker({ ...config, model }) so the override
// threads through buildWorker to the spawn path for BOTH runtimes. These tests
// pin that invariant at the Worker layer (the runAgent body relies on it).
// ---------------------------------------------------------------------------
describe('createWorker model override — Agent-SDK { prompt, model } parity', () => {
  it('overrides only the model, preserving every other Worker config field', () => {
    const base: WorkerConfig = Workers.Coder.config
    const overridden = createWorker({ ...base, model: 'claude-opus-4-7' })
    expect(overridden.config.model).toBe('claude-opus-4-7')
    // Identity of the Worker is otherwise unchanged: role, runtime, provider,
    // permission posture, tool denials, and context budget all carry through.
    expect(overridden.config.name).toBe(base.name)
    expect(overridden.config.runtime).toBe(base.runtime)
    expect(overridden.config.provider).toBe(base.provider)
    expect(overridden.config.permissionMode).toBe(base.permissionMode)
    expect(overridden.config.disallowedTools).toEqual(base.disallowedTools)
    expect(overridden.config.maxContextTokens).toBe(base.maxContextTokens)
    expect(overridden.runtime).toBe(base.runtime)
  })

  it('works for the Fixer Worker too (override applies to any resolved role)', () => {
    const overridden = createWorker({
      ...Workers.Fixer.config,
      model: 'claude-haiku-4-5-20251001',
    })
    expect(overridden.config.model).toBe('claude-haiku-4-5-20251001')
    expect(overridden.config.name).toBe('Fixer')
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
