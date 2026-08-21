/**
 * The Port acceptance test for the Executor Port (ADR-0097): an
 * `ExecutorRunArgs` survives `JSON.parse(JSON.stringify(...))` without loss.
 * That round-trip is what makes a future out-of-process implementation ("run
 * the agent in a managed sandbox") a drop-in registration rather than a
 * redesign — and it is what the `ExecutorRunArgs`/`ExecutorRunContext` split
 * exists to guarantee: the three non-serializable members live on the
 * context, never on the request.
 *
 * Plus the registry contract mirrored from `../../verifier/__tests__`:
 * built-in registration, require-throws-naming-known-kinds, and env-driven
 * resolution through the shared Port catalog.
 */
import { describe, expect, it } from 'vitest'
import {
  getExecutor,
  listExecutors,
  registerExecutor,
  requireExecutor,
  resolveExecutor,
} from '../registry'
import { localSubprocessExecutor } from '../local-subprocess'
import type { Executor, ExecutorRunArgs, RunAgentResult } from '../types'

/**
 * An args object populated in every optional member, so the round-trip below
 * is a real test of the whole shape rather than of the two required fields.
 */
const fullArgs: ExecutorRunArgs = {
  cwd: '/tmp/worktree',
  prompt: 'implement the slice',
  timeoutMs: 900_000,
  model: 'claude-sonnet-4-5',
  systemPrompt: 'you are a coder',
  sessionId: 'mars-f24cfcba',
  effort: 'high',
  permissionMode: 'acceptEdits',
  bare: false,
  agent: 'coder',
  disallowedTools: ['AskUserQuestion', 'SendUserMessage'],
  maxContextTokens: 180_000,
  mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['mcp'] } },
  taskId: 'mars-f24cfcba',
}

describe('ExecutorRunArgs is serializable', () => {
  it('round-trips through JSON.parse(JSON.stringify(args)) without loss', () => {
    const roundTripped = JSON.parse(JSON.stringify(fullArgs)) as ExecutorRunArgs
    expect(roundTripped).toEqual(fullArgs)
  })

  it('drops no key on the way through JSON', () => {
    const roundTripped = JSON.parse(JSON.stringify(fullArgs)) as ExecutorRunArgs
    expect(Object.keys(roundTripped).sort()).toEqual(Object.keys(fullArgs).sort())
    // A function-valued or handle-valued member would vanish here; the nested
    // MCP server record and the readonly tool array must survive intact.
    expect(roundTripped.disallowedTools).toEqual(['AskUserQuestion', 'SendUserMessage'])
    expect(roundTripped.mcpServers).toEqual(fullArgs.mcpServers)
  })

  it('round-trips a RunAgentResult without loss', () => {
    const result: RunAgentResult = {
      exitCode: 0,
      stdout: '{"type":"result"}',
      stderr: '',
      sessionId: '00000000-0000-4000-8000-000000000000',
      conversation: [],
      quotaRejected: null,
      transportDropped: false,
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})

describe('built-in registration', () => {
  it('registers the local implementation at import time', () => {
    expect(listExecutors().map((impl) => impl.kind)).toContain('local')
  })

  it('getExecutor resolves the built-in by kind', () => {
    expect(getExecutor('local')).toBe(localSubprocessExecutor)
  })

  it('getExecutor returns undefined for an unregistered kind', () => {
    expect(getExecutor('nope')).toBeUndefined()
  })

  it('requireExecutor throws naming the known kinds for an unregistered kind', () => {
    expect(() => requireExecutor('nope')).toThrow(/Unknown Executor implementation 'nope'/)
    expect(() => requireExecutor('nope')).toThrow(/local/)
  })
})

describe('registerExecutor()', () => {
  it('registers a new implementation and the returned disposer withdraws it', async () => {
    const fake: Executor = {
      kind: 'test-fake',
      async run(args: ExecutorRunArgs): Promise<RunAgentResult> {
        return {
          exitCode: 0,
          stdout: args.prompt,
          stderr: '',
          sessionId: null,
          conversation: [],
          quotaRejected: null,
        }
      },
    }
    const dispose = registerExecutor(fake)
    expect(getExecutor('test-fake')).toBe(fake)
    await expect(fake.run(fullArgs)).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'implement the slice',
    })
    dispose()
    expect(getExecutor('test-fake')).toBeUndefined()
  })
})

describe('resolveExecutor()', () => {
  it('defaults to the local implementation when the env var is unset', () => {
    expect(resolveExecutor({})).toBe(localSubprocessExecutor)
  })

  it('defaults to local when the env var is empty', () => {
    expect(resolveExecutor({ MARS_EXECUTOR_KIND: '' })).toBe(localSubprocessExecutor)
  })

  it('throws when the env var names a kind the shared Port registry does not declare', () => {
    expect(() => resolveExecutor({ MARS_EXECUTOR_KIND: 'bogus' })).toThrow(
      /not a registered implementation/,
    )
  })
})
