/**
 * Unit tests for `hasUnresolvedOpenQuestions` — the predicate that gates
 * `mars proposal slice` when a proposal's notes contain an unresolved
 * open-questions block.
 *
 * Acceptance criteria verified here:
 *   1. Notes with an OPEN QUESTIONS — block are blocked (the canonical incident case).
 *   2. Notes mentioning "open question" mid-sentence in prose are NOT blocked
 *      (the trigger requires the phrase to START a trimmed line).
 *   3. Empty / null / undefined notes are allowed.
 *   4. Notes already carrying a DEFAULTS ACCEPTED line still block — prior acceptance
 *      must not silently permit a later reslice to skip the gate.
 */

import { describe, expect, it } from 'vitest'
import { hasUnresolvedOpenQuestions } from '../proposals'

describe('hasUnresolvedOpenQuestions', () => {
  // -------------------------------------------------------------------------
  // 1. Blocks when a line starts with OPEN QUESTIONS (the incident case)
  // -------------------------------------------------------------------------

  it('returns true for notes with an OPEN QUESTIONS — block', () => {
    const notes = [
      'Background: the proposal covers a broadcast system.',
      '',
      'OPEN QUESTIONS — deliberately unresolved, flagged for the follow-up shaping pass:',
      '1. Changelog source of truth: DB table authored in admin',
      '   (recommended — announcing needs no deploy), or ...',
      '2. Admin deliverable: REST endpoints only (recommended — won\'t',
      '   collide with the UI in progress), or endpoints plus a bare',
      '   server-rendered page so it\'s usable before the UI lands.',
    ].join('\n')

    expect(hasUnresolvedOpenQuestions(notes)).toBe(true)
  })

  it('returns true for notes with OPEN QUESTION (singular)', () => {
    const notes = 'Some context.\n\nOPEN QUESTION: should this be async?\n'
    expect(hasUnresolvedOpenQuestions(notes)).toBe(true)
  })

  it('is case-insensitive — lower-case header still blocks', () => {
    const notes = 'Some context.\n\nopen questions — is this a problem?\n'
    expect(hasUnresolvedOpenQuestions(notes)).toBe(true)
  })

  it('handles leading whitespace on the header line (trimmed before match)', () => {
    const notes = '  OPEN QUESTIONS:\n1. Question here\n'
    expect(hasUnresolvedOpenQuestions(notes)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 2. Prose mention mid-sentence does NOT block
  // -------------------------------------------------------------------------

  it('returns false when "open question" appears only mid-sentence', () => {
    const notes = [
      'There is an open question about the API shape, but we will resolve it later.',
      'The implementation raises no other open questions at this stage.',
    ].join('\n')
    // Neither line STARTS with "OPEN QUESTION" — both start with other words.
    expect(hasUnresolvedOpenQuestions(notes)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 3. Empty / null / undefined notes are allowed
  // -------------------------------------------------------------------------

  it('returns false for empty string', () => {
    expect(hasUnresolvedOpenQuestions('')).toBe(false)
  })

  it('returns false for null', () => {
    expect(hasUnresolvedOpenQuestions(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(hasUnresolvedOpenQuestions(undefined)).toBe(false)
  })

  it('returns false for notes with no header at all', () => {
    const notes = 'This is a well-shaped proposal with a clear solution and no outstanding items.'
    expect(hasUnresolvedOpenQuestions(notes)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 4. Notes with DEFAULTS ACCEPTED still block (re-slice must also pass the gate)
  // -------------------------------------------------------------------------

  it('returns true even when DEFAULTS ACCEPTED is present — prior acceptance does not disable the gate', () => {
    const notes = [
      'OPEN QUESTIONS — unresolved:',
      '1. Should this be async?',
      '',
      'DEFAULTS ACCEPTED at 2026-08-05T12:00:00.000Z by Test User <test@example.com> — open questions above were not resolved before slicing.',
    ].join('\n')
    // OPEN QUESTIONS is still present; DEFAULTS ACCEPTED does not cancel it.
    expect(hasUnresolvedOpenQuestions(notes)).toBe(true)
  })
})
