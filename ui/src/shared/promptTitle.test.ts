/**
 * Unit tests for titleFromPrompt — the shared helper that strips Markdown
 * heading markers from the first line of a task prompt.
 */

import { describe, expect, it } from 'bun:test'
import { taskTitle, titleFromPrompt } from './promptTitle'

describe('titleFromPrompt – Markdown heading stripping', () => {
  it('strips a single # heading marker', () => {
    expect(titleFromPrompt('# Main committer')).toBe('Main committer')
  })

  it('strips ## double-hash heading', () => {
    expect(titleFromPrompt('## Sub-section title')).toBe('Sub-section title')
  })

  it('strips ### and deeper headings', () => {
    expect(titleFromPrompt('### Deep heading')).toBe('Deep heading')
    expect(titleFromPrompt('#### Even deeper')).toBe('Even deeper')
  })

  it('leaves plain text unchanged', () => {
    expect(titleFromPrompt('Add OAuth login')).toBe('Add OAuth login')
  })

  it('uses only the first line', () => {
    expect(titleFromPrompt('# First line\nSecond line ignored')).toBe('First line')
  })

  it('strips heading markers from the first line only (second line with # untouched)', () => {
    const result = titleFromPrompt('# Title\n# Not included')
    expect(result).toBe('Title')
  })

  it('falls back to the full trimmed prompt when first line is empty', () => {
    // A prompt that starts with a blank line
    expect(titleFromPrompt('\nActual content here')).toBe('Actual content here')
  })

  it('returns empty string for an empty prompt', () => {
    expect(titleFromPrompt('')).toBe('')
  })

  it('trims surrounding whitespace from the heading text', () => {
    expect(titleFromPrompt('#   Spaced heading  ')).toBe('Spaced heading')
  })

  it('handles CRLF line endings', () => {
    expect(titleFromPrompt('# Title\r\nBody')).toBe('Title')
  })
})

describe('titleFromPrompt – length control', () => {
  it('cuts a single-line brief at its first sentence', () => {
    // The shape that made board cards unscannable: a whole brief on one line.
    const prompt =
      'Remove the retired Pencil design source: delete design/ui.pen. ' +
      'The team now works on the UI directly in ui/ so the .pen file is no ' +
      'longer the design source of truth and must not linger.'
    expect(titleFromPrompt(prompt)).toBe(
      'Remove the retired Pencil design source: delete design/ui.pen.',
    )
  })

  it('hard-caps a first sentence that is itself enormous', () => {
    const result = titleFromPrompt(`${'x'.repeat(400)}. tail`)
    expect(result).toHaveLength(101) // 100 chars + ellipsis
    expect(result.endsWith('…')).toBe(true)
  })

  it('does not cut at a colon, which is a prefix separator not a sentence end', () => {
    expect(titleFromPrompt('Slice 1 of 5: add the fork endpoint')).toBe(
      'Slice 1 of 5: add the fork endpoint',
    )
  })

  it('leaves an already-short title untouched', () => {
    expect(titleFromPrompt('Add OAuth login')).toBe('Add OAuth login')
  })
})

describe('taskTitle', () => {
  it('prefers intent over the prompt', () => {
    expect(
      taskTitle({ intent: 'Fix the merge gate', prompt: '# Something else\nbody' }),
    ).toBe('Fix the merge gate')
  })

  it('normalises a Markdown slab stored in intent instead of trusting it', () => {
    // Real shape found in the tasks table — intent is not sanitised on write.
    const intent =
      '# Slice 11: CLI commands for verify gates and credentials\n\n' +
      'Add CLI subcommands for managing verify gates.\n\n## New file: x.ts'
    expect(taskTitle({ intent, prompt: 'unused' })).toBe(
      'Slice 11: CLI commands for verify gates and credentials',
    )
  })

  it('falls back to the prompt when intent is null', () => {
    expect(taskTitle({ intent: null, prompt: '# Derived title\nbody' })).toBe(
      'Derived title',
    )
  })

  it('falls back when intent is blank whitespace', () => {
    expect(taskTitle({ intent: '   ', prompt: 'Real title' })).toBe('Real title')
  })

  it('falls back when intent is absent entirely (legacy row)', () => {
    expect(taskTitle({ prompt: 'Legacy title' })).toBe('Legacy title')
  })
})
