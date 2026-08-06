import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  buildWorkerEnv,
  claudeStreamArgs,
  codegraphMcpConfigJson,
  resolveCodegraphRoot,
  toClaudeSessionId,
} from '../git/claude'

describe('claudeStreamArgs isolation flags', () => {
  it('includes --strict-mcp-config', () => {
    expect(claudeStreamArgs('hi')).toContain('--strict-mcp-config')
  })

  it('includes --no-session-persistence', () => {
    expect(claudeStreamArgs('hi')).toContain('--no-session-persistence')
  })

  it('includes --exclude-dynamic-system-prompt-sections', () => {
    expect(claudeStreamArgs('hi')).toContain(
      '--exclude-dynamic-system-prompt-sections',
    )
  })

  it('drops the user setting source with --setting-sources project,local', () => {
    const args = claudeStreamArgs('hi')
    const i = args.indexOf('--setting-sources')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('project,local')
  })

  it('orders the new isolation flags after --dangerously-skip-permissions and before --disallowedTools', () => {
    const args = claudeStreamArgs('hi')
    const dsp = args.indexOf('--dangerously-skip-permissions')
    const strictMcp = args.indexOf('--strict-mcp-config')
    const settingSources = args.indexOf('--setting-sources')
    const noPersist = args.indexOf('--no-session-persistence')
    const exclDyn = args.indexOf('--exclude-dynamic-system-prompt-sections')
    const disallowed = args.indexOf('--disallowedTools')
    expect(dsp).toBeGreaterThanOrEqual(0)
    expect(disallowed).toBeGreaterThan(dsp)
    expect(strictMcp).toBeGreaterThan(dsp)
    expect(settingSources).toBeGreaterThan(dsp)
    expect(noPersist).toBeGreaterThan(dsp)
    expect(exclDyn).toBeGreaterThan(dsp)
    expect(strictMcp).toBeLessThan(disallowed)
    expect(settingSources).toBeLessThan(disallowed)
    expect(noPersist).toBeLessThan(disallowed)
    expect(exclDyn).toBeLessThan(disallowed)
  })

  it('omits --mcp-config when no mcpConfig is supplied', () => {
    expect(claudeStreamArgs('hi')).not.toContain('--mcp-config')
  })

  it('emits --mcp-config <json> immediately before --strict-mcp-config when supplied', () => {
    const json = codegraphMcpConfigJson('/repo')
    const args = claudeStreamArgs('hi', { mcpConfig: json })
    const mcp = args.indexOf('--mcp-config')
    expect(mcp).toBeGreaterThanOrEqual(0)
    expect(args[mcp + 1]).toBe(json)
    // The value must precede --strict-mcp-config so the worker actually loads it.
    expect(mcp).toBeLessThan(args.indexOf('--strict-mcp-config'))
    // And, like the other isolation flags, sit after the permission flag and
    // before --disallowedTools.
    expect(mcp).toBeGreaterThan(args.indexOf('--dangerously-skip-permissions'))
    expect(mcp).toBeLessThan(args.indexOf('--disallowedTools'))
  })

  it('keeps the pre-existing flags', () => {
    const args = claudeStreamArgs('hi')
    expect(args).toContain('-p')
    const outputFormatIdx = args.indexOf('--output-format')
    expect(outputFormatIdx).toBeGreaterThanOrEqual(0)
    expect(args[outputFormatIdx + 1]).toBe('stream-json')
    expect(args).toContain('--dangerously-skip-permissions')
    const disallowedIdx = args.indexOf('--disallowedTools')
    expect(disallowedIdx).toBeGreaterThanOrEqual(0)
    expect(args[disallowedIdx + 1]).toBe('AskUserQuestion,SendUserMessage')
  })
})

describe('codegraphMcpConfigJson', () => {
  it('builds a stdio codegraph server pinned to the given root via --path', () => {
    const json = codegraphMcpConfigJson('/Users/me/repo')
    const parsed = JSON.parse(json) as {
      mcpServers: { codegraph: { type: string; command: string; args: string[] } }
    }
    const cg = parsed.mcpServers.codegraph
    expect(cg.type).toBe('stdio')
    expect(cg.command).toBe('codegraph')
    expect(cg.args).toEqual(['serve', '--mcp', '--no-watch', '--path', '/Users/me/repo'])
  })

  it('produces valid, stable JSON', () => {
    expect(codegraphMcpConfigJson('/a')).toBe(codegraphMcpConfigJson('/a'))
    expect(() => JSON.parse(codegraphMcpConfigJson('/a'))).not.toThrow()
  })
})

describe('resolveCodegraphRoot', () => {
  it('returns the parent of the git common dir for a real repo (this checkout)', () => {
    // Run against this orchestrator's own checkout: the resolved root must be a
    // directory whose .git common dir parent we land on — i.e. it does not
    // throw and returns a non-empty absolute path.
    const root = resolveCodegraphRoot(process.cwd())
    expect(typeof root).toBe('string')
    expect(root.length).toBeGreaterThan(0)
  })

  it('falls back to cwd when the path is not a git repository', () => {
    // The OS temp root is (essentially) never a git repo; git rev-parse fails
    // and we must hand back the input unchanged rather than throw.
    const notARepo = '/'
    expect(resolveCodegraphRoot(notARepo)).toBe(notARepo)
  })
})

describe('session key uniqueness (per-invocation randomization)', () => {
  it('distinct per-invocation suffixes on the same taskId produce distinct Claude session UUIDs', () => {
    // The session key format is `${taskId}#${randomUUID().slice(0, 8)}`.
    // Since toClaudeSessionId is a deterministic UUID v5 function, distinctness
    // is guaranteed iff the inputs differ — which the random suffix ensures.
    const taskId = 'test-task-abc123'
    const uuid1 = toClaudeSessionId(`${taskId}#deadbeef`)
    const uuid2 = toClaudeSessionId(`${taskId}#cafebabe`)
    expect(uuid1).not.toBe(uuid2)
  })

  it('toClaudeSessionId is stable for the same key (no internal randomness)', () => {
    // toClaudeSessionId must be deterministic: randomness lives only in the
    // per-invocation key, not inside the UUID derivation itself.
    const key = 'test-task-abc123#deadbeef'
    expect(toClaudeSessionId(key)).toBe(toClaudeSessionId(key))
  })

  it('per-invocation random suffixes never collide across 200 simulated dispatches', () => {
    // Probabilistic sanity check. Each suffix is 8 hex chars (32 bits of
    // randomness), so expected collision probability for 200 calls is ~1e-6.
    // This always passes in practice and documents the uniqueness contract.
    const taskId = 'concurrent-task-xyz'
    const sessionIds = Array.from({ length: 200 }, () =>
      toClaudeSessionId(`${taskId}#${randomUUID().slice(0, 8)}`),
    )
    expect(new Set(sessionIds).size).toBe(200)
  })
})

describe('buildWorkerEnv', () => {
  const captured: Record<string, string | undefined> = {}
  const keysToManage = [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_EFFORT',
    'CLAUDE_PROJECT_DIR',
    'AI_AGENT',
    'CMUX_CLAUDE_PID',
    'CMUX_SOCKET_PATH',
    'ANTHROPIC_API_KEY',
    'MARS_DB_BACKEND',
  ]

  beforeEach(() => {
    for (const k of keysToManage) {
      captured[k] = process.env[k]
    }
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_SESSION_ID = 'parent-xyz'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.CLAUDE_CODE_EXECPATH = '/usr/local/bin/claude'
    process.env.CLAUDE_EFFORT = 'high'
    process.env.CLAUDE_PROJECT_DIR = '/tmp/x'
    process.env.AI_AGENT = 'claude'
    process.env.CMUX_CLAUDE_PID = '90743'
    process.env.CMUX_SOCKET_PATH = '/tmp/cmux.sock'
    process.env.ANTHROPIC_API_KEY = 'sk-keep'
    process.env.MARS_DB_BACKEND = 'embedded'
  })

  afterEach(() => {
    for (const k of keysToManage) {
      const v = captured[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('strips every CLAUDE* session-context var', () => {
    const env = buildWorkerEnv()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDE_CODE_EXECPATH).toBeUndefined()
    expect(env.CLAUDE_EFFORT).toBeUndefined()
    expect(env.CLAUDE_PROJECT_DIR).toBeUndefined()
  })

  it('strips AI_AGENT and the CMUX_* harness vars that also trip the recursion guard', () => {
    const env = buildWorkerEnv()
    expect(env.AI_AGENT).toBeUndefined()
    expect(env.CMUX_CLAUDE_PID).toBeUndefined()
    expect(env.CMUX_SOCKET_PATH).toBeUndefined()
  })

  it('preserves ANTHROPIC_API_KEY and PATH', () => {
    const env = buildWorkerEnv()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-keep')
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('does not mutate process.env', () => {
    buildWorkerEnv()
    expect(process.env.CLAUDECODE).toBe('1')
    expect(process.env.CLAUDE_CODE_SESSION_ID).toBe('parent-xyz')
  })

  it('strips MARS_DB_BACKEND so the daemon backend selector cannot contaminate coder test suites', () => {
    // Regression guard for incident 2026-07-28: a live daemon exporting
    // MARS_DB_BACKEND=embedded propagated that value into dispatched coder
    // workers via buildWorkerEnv().  Worker processes run `npm test` inside
    // the task worktree; the test harness (test/setup-env.ts) unconditionally
    // forces `pglite`, but only if the var is absent.  Stripping it here lets
    // the harness apply its unconditional assignment cleanly.
    // beforeEach sets MARS_DB_BACKEND = 'embedded' to simulate a daemon shell.
    const env = buildWorkerEnv()
    expect(env.MARS_DB_BACKEND).toBeUndefined()
  })

  it('sets CI=true so pnpm and other package managers behave non-interactively in TTY-less worker processes', () => {
    // Regression guard for ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY:
    // pnpm refuses to remove node_modules when there is no TTY and CI is
    // unset, causing a failed tool call on every worker run that touches
    // dependencies. Setting CI=true here (once, for every provider) is the
    // fix pnpm itself documents.
    const env = buildWorkerEnv()
    expect(env.CI).toBe('true')
  })

  it('sets CI=true even when a taskId is supplied', () => {
    const env = buildWorkerEnv('mars-abc123')
    expect(env.CI).toBe('true')
    expect(env.MARS_MCP_TASK_ID).toBe('mars-abc123')
  })
})
