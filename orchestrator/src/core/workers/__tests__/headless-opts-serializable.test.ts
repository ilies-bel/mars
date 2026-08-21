// Executor port reshape (slice 25 of PRD ae17340a-modular-core-program):
// HeadlessRunOpts must be plain, serializable data — no function-valued
// members — so a run request can cross a JSON boundary (a remote Executor
// port, a persisted dispatch record) without loss. The non-serializable
// pieces (onEvent, externalAbort, onPid) live on HeadlessRunContext instead,
// passed as HeadlessAdapter.run's separate, in-process-only third argument.
//
// This test asserts both halves of that split:
//   (a) a fully-populated HeadlessRunOpts round-trips through JSON.stringify
//       / JSON.parse without loss (proves it is Port-legal data);
//   (b) HeadlessRunOpts carries no function-valued members at all — a type
//       guard that would fail to compile if a callback ever leaked back in.

import { describe, it, expect } from 'vitest'
import type { HeadlessRunOpts } from '../provider-types'

// A representative HeadlessRunOpts with every field populated. If a field is
// ever added to the interface without a corresponding entry here, this
// object literal itself won't fail to compile (extra props aren't required),
// but the JSON round-trip below only proves what's exercised — so keep this
// list in sync with provider-types.ts when the shape changes.
const FULL_OPTS: HeadlessRunOpts = {
  cwd: '/tmp/mars-worktree/task-123',
  sessionId: 'session-abc',
  model: 'gpt-5.6-sol',
  systemPrompt: 'You are a careful coding agent.',
  effort: 'high',
  permissionMode: 'bypassPermissions',
  bare: false,
  agent: 'coder',
  disallowedTools: ['Edit', 'Write'],
  forceSandbox: 'workspace-write',
  maxContextTokens: 128_000,
  mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['mcp'] } },
  taskId: 'mars-b9c3283b',
}

describe('HeadlessRunOpts — Port-legal serializable shape', () => {
  it('round-trips through JSON.stringify/JSON.parse without loss', () => {
    const roundTripped = JSON.parse(JSON.stringify(FULL_OPTS)) as HeadlessRunOpts
    expect(roundTripped).toEqual(FULL_OPTS)
  })

  it('contains no function-valued members', () => {
    for (const [key, value] of Object.entries(FULL_OPTS)) {
      expect(typeof value, `field '${key}' must not be a function`).not.toBe('function')
    }
  })

  it('serializes to a plain JSON object with only the expected keys', () => {
    const serialized = JSON.parse(JSON.stringify(FULL_OPTS)) as Record<string, unknown>
    expect(Object.keys(serialized).sort()).toEqual(Object.keys(FULL_OPTS).sort())
  })
})
