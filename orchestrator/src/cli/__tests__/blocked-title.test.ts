import { describe, expect, it } from 'vitest'
import { blockedTaskTitle } from '../blocked-title'

describe('blockedTaskTitle', () => {
  it('returns the first non-empty line for a plain prompt', () => {
    const prompt = 'Add the inbox writer/reader library at orchestrator/src/mastra/lib/inbox.ts.\n\nThis is...'
    expect(blockedTaskTitle(prompt)).toBe(
      'Add the inbox writer/reader library at orchestrator/src/mastra/lib/inbox.ts.',
    )
  })

  it('skips a leading markdown heading and returns the next content line', () => {
    const prompt = '# Goal\n\nFinish the originId integration so spans carry their origin.\n\n# Plan\n...'
    expect(blockedTaskTitle(prompt)).toBe(
      'Finish the originId integration so spans carry their origin.',
    )
  })

  it('skips multiple stacked headings and blank lines', () => {
    const prompt = '# How to implement this slice\n\n## Context\n\nMove observability to LibSQLStore.'
    expect(blockedTaskTitle(prompt)).toBe('Move observability to LibSQLStore.')
  })

  it('truncates lines longer than 80 chars with an ellipsis', () => {
    const long = 'x'.repeat(120)
    const out = blockedTaskTitle(long)
    expect(out.length).toBe(80)
    expect(out.endsWith('...')).toBe(true)
  })

  it('falls back to the heading itself when the prompt is heading-only', () => {
    const prompt = '# Goal\n'
    expect(blockedTaskTitle(prompt)).toBe('# Goal')
  })

  it('returns "(no prompt)" for empty / whitespace / nullish input', () => {
    expect(blockedTaskTitle('')).toBe('(no prompt)')
    expect(blockedTaskTitle('   \n\n  ')).toBe('(no prompt)')
    expect(blockedTaskTitle(null)).toBe('(no prompt)')
    expect(blockedTaskTitle(undefined)).toBe('(no prompt)')
  })

  it('handles \\r\\n line endings', () => {
    const prompt = '# Goal\r\n\r\nDo the thing.\r\n'
    expect(blockedTaskTitle(prompt)).toBe('Do the thing.')
  })
})
