import { describe, it, expect } from 'vitest'
import { taskDisplayTitle } from '../task-display-title'

describe('taskDisplayTitle', () => {
  // ── Tier 1: intent ────────────────────────────────────────────────────────

  it('returns intent verbatim when non-empty', () => {
    expect(
      taskDisplayTitle({
        intent: 'Fix the merge guard',
        prompt: '# Some heading\nsome body',
      }),
    ).toBe('Fix the merge guard')
  })

  it('trims surrounding whitespace from intent', () => {
    expect(
      taskDisplayTitle({ intent: '  Close the hatch  ', prompt: 'ignored' }),
    ).toBe('Close the hatch')
  })

  it('falls through to prompt when intent is empty string', () => {
    expect(
      taskDisplayTitle({ intent: '', prompt: '# The real title\nbody' }),
    ).toBe('The real title')
  })

  it('falls through to prompt when intent is null', () => {
    expect(
      taskDisplayTitle({ intent: null, prompt: '# Heading only' }),
    ).toBe('Heading only')
  })

  it('falls through to prompt when intent is whitespace-only', () => {
    expect(
      taskDisplayTitle({ intent: '   ', prompt: '# Whitespace intent' }),
    ).toBe('Whitespace intent')
  })

  it('falls through to prompt when intent is undefined', () => {
    expect(
      taskDisplayTitle({ prompt: '# From prompt' }),
    ).toBe('From prompt')
  })

  // ── Tier 2: first markdown heading ───────────────────────────────────────

  it('strips single # marker from a heading', () => {
    expect(
      taskDisplayTitle({ prompt: '# Recover lost work\n\nbody text' }),
    ).toBe('Recover lost work')
  })

  it('strips multi-# markers from a heading', () => {
    expect(
      taskDisplayTitle({ prompt: '### Deep heading\nbody' }),
    ).toBe('Deep heading')
  })

  it('skips non-heading lines before the first heading', () => {
    expect(
      taskDisplayTitle({ prompt: '\n\n## The heading\nbody' }),
    ).toBe('The heading')
  })

  it('strips "Slice N of M" scaffolding at the end of a heading', () => {
    expect(
      taskDisplayTitle({ prompt: '# Fix the bug Slice 3 of 5\nbody' }),
    ).toBe('Fix the bug')
  })

  it('strips "Slice N of M for PRD …" scaffolding at the end of a heading', () => {
    expect(
      taskDisplayTitle({
        prompt: '# Implement auth Slice 1 of 4 for PRD the-auth-prd\nbody',
      }),
    ).toBe('Implement auth')
  })

  it('collapses internal whitespace in a heading', () => {
    expect(
      taskDisplayTitle({ prompt: '#   Lots   of   spaces  \nbody' }),
    ).toBe('Lots of spaces')
  })

  // ── Tier 3: first non-empty line ─────────────────────────────────────────

  it('returns first non-empty line when there is no heading', () => {
    expect(
      taskDisplayTitle({ prompt: 'You are a focused recovery agent.\nbody' }),
    ).toBe('You are a focused recovery agent.')
  })

  it('strips "Slice N of M" scaffolding from a non-heading first line', () => {
    expect(
      taskDisplayTitle({ prompt: 'Do the work Slice 2 of 6\ndetails' }),
    ).toBe('Do the work')
  })

  it('collapses internal whitespace in a non-heading first line', () => {
    expect(
      taskDisplayTitle({ prompt: '  Multi   space   line  \nnext' }),
    ).toBe('Multi space line')
  })

  // ── Multi-line prompts → single-line title ────────────────────────────────

  it('a multi-line prompt yields a single-line title', () => {
    const title = taskDisplayTitle({
      prompt: [
        '# Close the done-implies-merged escape hatch',
        '',
        'A deleted branch should not count as merged.',
        'This is a very long description that spans many lines.',
      ].join('\n'),
    })
    expect(title).not.toContain('\n')
    expect(title).toBe('Close the done-implies-merged escape hatch')
  })

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('returns empty string for a blank prompt', () => {
    expect(taskDisplayTitle({ prompt: '' })).toBe('')
  })

  it('returns empty string for an all-whitespace prompt', () => {
    expect(taskDisplayTitle({ prompt: '   \n  \n  ' })).toBe('')
  })

  it('handles a prompt that is only a bare # with no body', () => {
    // A lone '#' with no content → stripped to '' → falls to tier 3 → also ''
    expect(taskDisplayTitle({ prompt: '#' })).toBe('')
  })

  it('does not include the # marker in the output', () => {
    const title = taskDisplayTitle({ prompt: '# Task title\nbody' })
    expect(title).not.toMatch(/^#/)
  })
})
