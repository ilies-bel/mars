import { describe, expect, it } from 'vitest'
import {
  claudeStreamArgs,
  SEARCH_TOOL_SYSTEM_PROMPT,
  toClaudeSessionId,
} from '../git/claude'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('claudeStreamArgs', () => {
  it('always denies AskUserQuestion and SendUserMessage', () => {
    const args = claudeStreamArgs('hello')
    const i = args.indexOf('--disallowedTools')
    expect(i).toBeGreaterThanOrEqual(0)
    const denied = args[i + 1] ?? ''
    expect(denied).toContain('AskUserQuestion')
    expect(denied).toContain('SendUserMessage')
  })

  it('still denies the agent-to-user tools when called with no options', () => {
    const args = claudeStreamArgs('hello')
    expect(args).toContain('--disallowedTools')
  })

  it('still denies the agent-to-user tools when options are supplied', () => {
    const args = claudeStreamArgs('hello', {
      model: 'claude-opus-4-7',
      systemPrompt: 'be brief',
      sessionId: 'sid-1',
    })
    const i = args.indexOf('--disallowedTools')
    expect(i).toBeGreaterThanOrEqual(0)
    const denied = args[i + 1] ?? ''
    expect(denied.split(',')).toEqual(
      expect.arrayContaining(['AskUserQuestion', 'SendUserMessage']),
    )
  })

  it('merges a caller-supplied disallowedTools list with the agent-to-user denials', () => {
    const args = claudeStreamArgs('hello', {
      disallowedTools: ['Bash', 'WebFetch'],
    })
    const i = args.indexOf('--disallowedTools')
    expect(i).toBeGreaterThanOrEqual(0)
    const denied = (args[i + 1] ?? '').split(',')
    expect(denied).toEqual(
      expect.arrayContaining([
        'AskUserQuestion',
        'SendUserMessage',
        'Bash',
        'WebFetch',
      ]),
    )
  })

  it('cannot be overridden away by a caller list that omits the agent-to-user tools', () => {
    const args = claudeStreamArgs('hello', {
      disallowedTools: ['Bash'],
    })
    const i = args.indexOf('--disallowedTools')
    const denied = (args[i + 1] ?? '').split(',')
    expect(denied).toContain('AskUserQuestion')
    expect(denied).toContain('SendUserMessage')
  })

  it('does not duplicate AskUserQuestion when caller also lists it', () => {
    const args = claudeStreamArgs('hello', {
      disallowedTools: ['AskUserQuestion', 'Bash'],
    })
    const i = args.indexOf('--disallowedTools')
    const denied = (args[i + 1] ?? '').split(',')
    const askCount = denied.filter((t) => t === 'AskUserQuestion').length
    expect(askCount).toBe(1)
  })

  it('passes through the prompt, model, and systemPrompt', () => {
    const args = claudeStreamArgs('hello', {
      model: 'm',
      systemPrompt: 'sp',
      sessionId: 'sid',
    })
    expect(args).toContain('hello')
    expect(args).toContain('--model')
    expect(args).toContain('m')
    const sysIdx = args.indexOf('--system-prompt')
    expect(sysIdx).toBeGreaterThanOrEqual(0)
    const sysVal = args[sysIdx + 1] ?? ''
    expect(sysVal).toContain(SEARCH_TOOL_SYSTEM_PROMPT)
    expect(sysVal).toContain('sp')
    expect(args).toContain('--session-id')
  })

  it('normalises a non-UUID sessionId to a valid UUID for --session-id', () => {
    // claude rejects a non-UUID --session-id with "Invalid session ID. Must be
    // a valid UUID.", exiting before doing any work. The stream path must emit
    // a UUID, never the raw task id.
    const args = claudeStreamArgs('hello', { sessionId: 'mars-9afa7df6' })
    const i = args.indexOf('--session-id')
    expect(i).toBeGreaterThanOrEqual(0)
    const sid = args[i + 1] ?? ''
    expect(sid).not.toBe('mars-9afa7df6')
    expect(sid).toMatch(UUID_RE)
  })

  it('passes an already-valid UUID sessionId through unchanged', () => {
    const uuid = '11111111-2222-4333-8444-555555555555'
    const args = claudeStreamArgs('hello', { sessionId: uuid })
    const i = args.indexOf('--session-id')
    expect(args[i + 1]).toBe(uuid)
  })
})

describe('toClaudeSessionId', () => {
  it('returns a valid UUID for a non-UUID task id', () => {
    expect(toClaudeSessionId('mars-9afa7df6')).toMatch(UUID_RE)
  })

  it('is deterministic — same task id maps to the same UUID', () => {
    expect(toClaudeSessionId('mars-9afa7df6')).toBe(
      toClaudeSessionId('mars-9afa7df6'),
    )
  })

  it('passes an already-valid UUID through unchanged', () => {
    const uuid = '11111111-2222-4333-8444-555555555555'
    expect(toClaudeSessionId(uuid)).toBe(uuid)
  })

  it('always injects the default search-tool guidance, even with no caller systemPrompt', () => {
    const args = claudeStreamArgs('hello')
    const sysIdx = args.indexOf('--system-prompt')
    expect(sysIdx).toBeGreaterThanOrEqual(0)
    expect(args[sysIdx + 1]).toBe(SEARCH_TOOL_SYSTEM_PROMPT)
  })
})
