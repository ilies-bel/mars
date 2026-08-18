/**
 * `splitProposalProse` — the write-boundary fix for illegible proposals.
 *
 * `mars proposal add ("<goal>" | @<file> | -)` passes its entire prose
 * argument to `createProposal` as the `title`. Agent-authored proposals are
 * multi-paragraph documents, so before this split the whole document landed in
 * `proposals.title` while `problem` stayed `''` — a 2000-3800 char unbroken
 * paragraph where the title should be, plus a `generateProposalId` slug
 * truncated mid-sentence.
 *
 * These are pure-function tests: no database, no module reset. The DB-backed
 * end-to-end assertion (a 2000-char blob through `createProposal`) lives in
 * `create-proposal-prose-split.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { PROPOSAL_TITLE_LIMIT, splitProposalProse } from '../proposals'

describe('splitProposalProse', () => {
  it('leaves a single-line prose unchanged and produces an empty body', () => {
    const { title, body } = splitProposalProse('Add a typescript typecheck verify gate')
    expect(title).toBe('Add a typescript typecheck verify gate')
    expect(body).toBe('')
  })

  it('strips a leading markdown heading marker from the title line', () => {
    const { title, body } = splitProposalProse('## Proposals are illegible\n\nthe body')
    expect(title).toBe('Proposals are illegible')
    expect(body).toBe('the body')
  })

  it('strips every heading level from `#` through `######`', () => {
    for (const marker of ['#', '##', '###', '####', '#####', '######']) {
      expect(splitProposalProse(`${marker} Heading`).title).toBe('Heading')
    }
  })

  it('does not strip a `#` that is not a heading marker (no following space)', () => {
    // `#123` is an issue reference, not a heading — the marker regex requires
    // trailing whitespace precisely so this survives intact.
    expect(splitProposalProse('#123 broke the merge gate').title).toBe(
      '#123 broke the merge gate',
    )
  })

  it('cuts an over-long first line at the last word boundary and appends an ellipsis', () => {
    const longLine = 'word '.repeat(40).trim() // 199 chars, spaces throughout
    const { title, body } = splitProposalProse(longLine)

    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(PROPOSAL_TITLE_LIMIT)
    // Cut on a boundary: no partial word is left dangling before the ellipsis.
    // 24 whole words (119 chars) fit under the 120 limit; the 25th does not.
    expect(title.slice(0, -1)).toBe('word '.repeat(24).trim())
    expect(body).toBe('')
  })

  it('never returns a title longer than the limit, even with no word boundary to cut on', () => {
    // A single unbroken token: there is no space to cut at, so the fallback
    // hard-truncates. The result must still fit within the limit — the
    // pg-schema backfill selects rows on `char_length(title) > 120`, so an
    // over-long derived title would re-match and rewrite itself every boot.
    const { title } = splitProposalProse('x'.repeat(400))
    expect(title.length).toBe(PROPOSAL_TITLE_LIMIT)
    expect(title.endsWith('…')).toBe(true)
  })

  it('keeps a first line exactly at the limit intact, with no ellipsis', () => {
    const exact = 'y'.repeat(PROPOSAL_TITLE_LIMIT)
    const { title } = splitProposalProse(exact)
    expect(title).toBe(exact)
    expect(title.endsWith('…')).toBe(false)
  })

  it('puts everything after the first line into the body, preserving paragraphs', () => {
    const prose = [
      '# Proposals are illegible',
      '',
      '## Symptom',
      '',
      'Every planner-sourced draft renders as a wall of text.',
      '',
      '## Root cause',
      '',
      'createProposal stores the whole blob as `title`.',
    ].join('\n')

    const { title, body } = splitProposalProse(prose)
    expect(title).toBe('Proposals are illegible')
    expect(body).toBe(
      [
        '## Symptom',
        '',
        'Every planner-sourced draft renders as a wall of text.',
        '',
        '## Root cause',
        '',
        'createProposal stores the whole blob as `title`.',
      ].join('\n'),
    )
  })

  it('skips leading blank lines when choosing the title line', () => {
    const { title, body } = splitProposalProse('\n\n\n   \nReal title\nbody line')
    expect(title).toBe('Real title')
    expect(body).toBe('body line')
  })

  it('returns empty title and body for all-blank prose', () => {
    // Callers fall back to the raw trimmed input in this case rather than
    // silently substituting a blank title.
    expect(splitProposalProse('')).toEqual({ title: '', body: '' })
    expect(splitProposalProse('\n\n   \n\t\n')).toEqual({ title: '', body: '' })
  })
})
