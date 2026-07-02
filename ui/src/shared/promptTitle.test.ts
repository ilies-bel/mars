/**
 * Unit tests for titleFromPrompt — the shared helper that strips Markdown
 * heading markers from the first line of a task prompt.
 */

import { describe, expect, it } from 'bun:test'
import { titleFromPrompt } from './promptTitle'

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
