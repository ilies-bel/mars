import { describe, expect, it } from 'vitest'
import { claudeStreamArgs, SEARCH_TOOL_SYSTEM_PROMPT } from '../git'

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

  it('passes through the prompt, model, systemPrompt, and sessionId', () => {
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
    expect(args).toContain('sid')
  })

  it('always injects the default search-tool guidance, even with no caller systemPrompt', () => {
    const args = claudeStreamArgs('hello')
    const sysIdx = args.indexOf('--system-prompt')
    expect(sysIdx).toBeGreaterThanOrEqual(0)
    expect(args[sysIdx + 1]).toBe(SEARCH_TOOL_SYSTEM_PROMPT)
  })
})
