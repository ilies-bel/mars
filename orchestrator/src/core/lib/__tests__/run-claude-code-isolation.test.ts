import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildWorkerEnv, claudeStreamArgs } from '../git/claude'

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

describe('buildWorkerEnv', () => {
  const captured: Record<string, string | undefined> = {}
  const keysToManage = [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_EFFORT',
    'CLAUDE_PROJECT_DIR',
    'ANTHROPIC_API_KEY',
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
    process.env.ANTHROPIC_API_KEY = 'sk-keep'
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
})
