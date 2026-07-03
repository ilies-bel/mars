import { describe, expect, it } from 'vitest'
import { parseClaudeStreamLine, extractLastStreamText } from '../claude-stream'

describe('parseClaudeStreamLine', () => {
  it('returns null for blank lines', () => {
    expect(parseClaudeStreamLine('')).toBeNull()
    expect(parseClaudeStreamLine('   ')).toBeNull()
    expect(parseClaudeStreamLine('\n')).toBeNull()
  })

  it('returns null for non-JSON lines', () => {
    expect(parseClaudeStreamLine('not json at all')).toBeNull()
    expect(parseClaudeStreamLine('[1, 2, 3]')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseClaudeStreamLine('{not json}')).toBeNull()
    expect(parseClaudeStreamLine('{"type": "x"')).toBeNull()
  })

  it('returns null when type field is missing', () => {
    expect(parseClaudeStreamLine('{"foo": "bar"}')).toBeNull()
  })

  it('parses a system.init event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'abc-123',
    })
    const event = parseClaudeStreamLine(line)
    expect(event).toEqual({ type: 'system', subtype: 'init', session_id: 'abc-123' })
  })

  it('preserves assistant text in full', () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'a'.repeat(10_000) }],
    }
    const event = parseClaudeStreamLine(JSON.stringify({ type: 'assistant', message }))
    expect(event?.type).toBe('assistant')
    const content = (event?.message as { content: Array<{ text: string }> }).content
    expect(content[0].text).toHaveLength(10_000)
  })

  it('keeps small tool_use input intact (in assistant message)', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      ],
    }
    const event = parseClaudeStreamLine(JSON.stringify({ type: 'assistant', message }))
    const block = (event?.message as { content: Array<Record<string, unknown>> }).content[0]
    expect(block.input).toEqual({ file_path: '/x' })
  })

  it('truncates oversized tool_use input', () => {
    const big = 'x'.repeat(5_000)
    const message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Write', input: { content: big } },
      ],
    }
    const event = parseClaudeStreamLine(JSON.stringify({ type: 'assistant', message }))
    const block = (event?.message as { content: Array<Record<string, unknown>> }).content[0]
    const input = block.input as { truncated: boolean; originalBytes: number; head: string }
    expect(input.truncated).toBe(true)
    expect(input.originalBytes).toBeGreaterThan(2 * 1024)
    expect(input.head.length).toBeLessThanOrEqual(2048)
  })

  it('keeps small tool_result content intact (in user message)', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'short result' },
      ],
    }
    const event = parseClaudeStreamLine(JSON.stringify({ type: 'user', message }))
    const block = (event?.message as { content: Array<Record<string, unknown>> }).content[0]
    expect(block.content).toBe('short result')
  })

  it('truncates oversized tool_result content', () => {
    const big = 'y'.repeat(10_000)
    const message = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: big },
      ],
    }
    const event = parseClaudeStreamLine(JSON.stringify({ type: 'user', message }))
    const block = (event?.message as { content: Array<Record<string, unknown>> }).content[0]
    const content = block.content as { truncated: boolean; originalBytes: number; head: string }
    expect(content.truncated).toBe(true)
    expect(content.originalBytes).toBeGreaterThan(4 * 1024)
    expect(content.head.length).toBeLessThanOrEqual(2048)
  })

  it('parses a result event in full', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 's1',
    })
    const event = parseClaudeStreamLine(line)
    expect(event).toEqual({
      type: 'result',
      subtype: 'success',
      session_id: 's1',
    })
  })
})

describe('extractLastStreamText', () => {
  it('returns null for an empty conversation', () => {
    expect(extractLastStreamText([])).toBeNull()
  })

  it('returns null when no result or assistant events are present', () => {
    const conversation = [
      { type: 'system', subtype: 'init', session_id: 'abc' },
    ]
    expect(extractLastStreamText(conversation)).toBeNull()
  })

  it('returns the result event text for an API-level error (monthly spend limit pattern)', () => {
    const conversation = [
      { type: 'system', subtype: 'init', session_id: 'abc' },
      {
        type: 'result',
        subtype: 'error_api_error',
        is_error: true,
        result: "You've hit your monthly spend limit. Please wait or upgrade your plan.",
        session_id: 'abc',
      },
    ]
    expect(extractLastStreamText(conversation)).toBe(
      "You've hit your monthly spend limit. Please wait or upgrade your plan.",
    )
  })

  it('returns the last assistant message text when no result event is present', () => {
    const conversation = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is the implementation.' }],
        },
      },
    ]
    expect(extractLastStreamText(conversation)).toBe('Here is the implementation.')
  })

  it('prefers the result event over the assistant message when both are present', () => {
    const conversation = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Working on it...' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'All done.',
        session_id: 'abc',
      },
    ]
    expect(extractLastStreamText(conversation)).toBe('All done.')
  })

  it('returns null when result event has an empty result string', () => {
    const conversation = [
      { type: 'result', subtype: 'success', result: '', session_id: 'abc' },
    ]
    // No non-empty result string and no assistant events → null
    expect(extractLastStreamText(conversation)).toBeNull()
  })

  it('falls back to assistant text when result event has an empty result string', () => {
    const conversation = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello there.' }],
        },
      },
      { type: 'result', subtype: 'success', result: '', session_id: 'abc' },
    ]
    expect(extractLastStreamText(conversation)).toBe('Hello there.')
  })

  it('returns null when result field is not a string', () => {
    const conversation = [
      { type: 'result', subtype: 'success', result: 42, session_id: 'abc' },
    ]
    expect(extractLastStreamText(conversation)).toBeNull()
  })

  it('picks the LAST result event when multiple are present', () => {
    const conversation = [
      { type: 'result', result: 'first result', session_id: 'abc' },
      { type: 'result', result: 'second result', session_id: 'abc' },
    ]
    expect(extractLastStreamText(conversation)).toBe('second result')
  })

  it('ignores non-text content blocks in assistant messages', () => {
    const conversation = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            { type: 'text', text: 'The answer is 42.' },
          ],
        },
      },
    ]
    expect(extractLastStreamText(conversation)).toBe('The answer is 42.')
  })
})
