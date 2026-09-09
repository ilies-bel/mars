/**
 * Tests for threadListTitle — the NAME a chat thread goes by in the sidebar.
 *
 * The bug: an alert thread's stored title is the alert's whole advisory
 * sentence, and the sidebar row gave it 98px. Measured on a live session, two
 * threads both rendered as "A task got s…" — 10% and 7% of 944px and 1343px of
 * text — with no `title` attribute, so hover revealed nothing either. Choosing
 * a thread is the only thing that list is for, and it could not be done.
 *
 * The rule these lock in: keep the clause that names the subject, drop the
 * clause that gives advice. Nothing is rewritten or summarised — the words are
 * the daemon's own, cut at a boundary it wrote.
 */
import { describe, expect, it } from 'vitest'
import { threadListTitle } from './chatPageUtils'

describe('threadListTitle', () => {
  it('keeps the subject and drops the advice at the daemon’s own em dash', () => {
    expect(
      threadListTitle(
        'A task got stuck and Mars used up its automatic retry — nothing is fixing this now, you need to decide what to do (mars-11b722e8).',
      ),
    ).toBe('A task got stuck and Mars used up its automatic retry')
  })

  it('cuts at a sentence stop when there is no em dash', () => {
    expect(
      threadListTitle(
        'Mars spotted patterns in recent work worth reviewing. This is informational, no action needed from you.',
      ),
    ).toBe('Mars spotted patterns in recent work worth reviewing')
  })

  it('leaves a title that is already a name completely alone', () => {
    expect(threadListTitle('Grill: KPI regression: failure_rate drifted +32.6%')).toBe(
      'Grill: KPI regression: failure_rate drifted +32.6%',
    )
  })

  it('does not cut when the head would be too short to be a name', () => {
    // A three-word fragment is worse than the whole sentence.
    const full = 'It broke — the coder could not resolve the import cycle in core/arc.'
    expect(threadListTitle(full)).toBe(full)
  })

  it('drops a parenthesis the stored title cut off mid-token', () => {
    // The API stores a bounded title, so a long advisory arrives already
    // truncated — sometimes leaving "(mars-" hanging with no closing paren.
    expect(
      threadListTitle(
        'A task got stuck and Mars used up its automatic retry, nothing is fixing this now (mars-',
      ),
    ).toBe('A task got stuck and Mars used up its automatic retry, nothing is fixing this now')
  })

  it('keeps a parenthetical that is actually closed', () => {
    expect(
      threadListTitle('An update is available for the background engine (5 commits behind) — restart it'),
    ).toBe('An update is available for the background engine (5 commits behind)')
  })

  it('strips a markdown heading marker from a pasted prompt body', () => {
    expect(threadListTitle('# Untangle the core/arc/blockers.ts import cycle')).toBe(
      'Untangle the core/arc/blockers.ts import cycle',
    )
  })

  it('falls back to the first user message when there is no title', () => {
    expect(threadListTitle(null, 'why did mars-1234 fail')).toBeTruthy()
  })

  it('never returns an empty string', () => {
    // A title that is nothing but a boundary character must not vanish.
    expect(threadListTitle('—')).toBe('—')
    expect(threadListTitle('.')).toBe('.')
  })
})
