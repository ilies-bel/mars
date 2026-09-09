/**
 * ProposalsPage — title/body legibility.
 *
 * Every planner-sourced draft used to render as an unbroken wall of text: the
 * whole prose document was stored in `title` and `problem` was empty. The
 * write boundary now splits the two (`splitProposalProse`), but the card must
 * stay legible even for a legacy row the backfill has not reached — hence a
 * CSS line clamp on the title rather than a data-only fix.
 */

import { vi, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DraftFeature } from '@/shared/schemas'

const proposals: DraftFeature[] = []
/** Total matching drafts before pagination; `render` defaults it to the page
 *  length, and the badge test overrides it to prove the two are independent. */
let total = 0

vi.mock('@/entities/proposals/useProposals', () => ({
  useProposals: () => ({
    proposals,
    total,
    isPending: false,
    error: null,
    connected: true,
    refetch: () => {},
  }),
}))

const { ProposalsPage } = await import('./ProposalsPage')

const draft = (overrides: Partial<DraftFeature> = {}): DraftFeature =>
  ({
    id: 'prop-abc-123',
    title: 'Proposals are illegible',
    problem: '',
    solution: '',
    status: 'draft',
    source: 'planner',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    acceptanceCount: 0,
    userStories: [],
    ...overrides,
  }) as DraftFeature

const render = (drafts: DraftFeature[], totalOverride?: number): string => {
  proposals.splice(0, proposals.length, ...drafts)
  total = totalOverride ?? drafts.length
  return renderToStaticMarkup(<ProposalsPage />)
}

describe('ProposalsPage — header count', () => {
  // Regression for the divergent-counts bug: the badge rendered
  // `proposals.length`, but that array is one page capped at the fetch limit
  // (50). With more drafts than the limit the page showed the cap while the
  // triage page's draft-proposal row showed the true number — two numbers for
  // one population. The badge must render the daemon's pre-pagination total.
  it('renders the pre-pagination total, not the length of the fetched page', () => {
    const page = Array.from({ length: 50 }, (_, i) => draft({ id: `prop-${i}` }))
    const html = render(page, 198)

    expect(html).toContain('>198<')
    expect(html).toContain('198 draft proposals awaiting review')
    expect(html).not.toContain('>50<')
  })

  // The heading names the population it counts, so it cannot be confused with
  // the Progress board's "PROPOSALS (ALL)" column, which counts every status.
  it('labels the header with the population it counts', () => {
    const html = render([draft()])
    expect(html).toContain('Draft proposals')
  })
})

describe('ProposalsPage — title clamping', () => {
  it('clamps the title to two lines so a long legacy title cannot take over the card', () => {
    const html = render([draft({ title: 'A very long legacy title. '.repeat(60) })])
    expect(html).toContain('line-clamp-2')
  })

  it('keeps the title as the strongest element in the card', () => {
    const html = render([draft()])
    // Title is at title size / semibold (the primary scanning target); the
    // preview below is text-body muted — clearly secondary. The clamp bounds
    // the title without changing the hierarchy.
    expect(html).toContain('text-title font-semibold')
  })
})

describe('ProposalsPage — body preview', () => {
  it('renders the body beneath the title, clamped to three lines', () => {
    const html = render([
      draft({ problem: 'First paragraph of the body.\n\nSecond paragraph of the body.' }),
    ])

    expect(html).toContain('line-clamp-3')
    const titleAt = html.indexOf('Proposals are illegible')
    const bodyAt = html.indexOf('First paragraph of the body.')
    expect(titleAt).toBeGreaterThan(-1)
    expect(bodyAt).toBeGreaterThan(titleAt)
  })

  it('collapses newlines to spaces so a multi-paragraph body reads as one run', () => {
    const html = render([draft({ problem: 'line one\nline two\n\nline three' })])
    // Not "line onelinetwo" and not a preview cut down to just the first line.
    expect(html).toContain('line one line two line three')
  })

  it('omits the preview entirely when the body is empty', () => {
    const html = render([draft({ problem: '' })])
    expect(html).not.toContain('line-clamp-3')
  })
})

describe('ProposalsPage — row action buttons', () => {
  // Slice 3: replace the /mars:grill <id> CopyButton with inline Grill and
  // Promote buttons so the operator can act without leaving the UI.

  it('renders a Grill button instead of the grill command CopyButton', () => {
    const html = render([draft()])
    expect(html).toContain('Grill')
    // The copy-paste CLI command must not appear anywhere in the rendered output
    expect(html).not.toContain('/mars:grill')
  })

  it('renders a Promote button in the row footer', () => {
    const html = render([draft()])
    expect(html).toContain('Promote')
  })

  // Dismiss led the row, which put the one irreversible verb first and gave
  // the affirmative path (Review -> Grill -> Promote) no leading position.
  // The three constructive actions now read left to right in the order an
  // operator would take them, and Dismiss is pushed to the right edge.
  it('renders footer actions in order: Review, Grill, Promote, then Dismiss last', () => {
    const html = render([draft()])
    const reviewAt = html.indexOf('Review')
    const grillAt = html.indexOf('>Grill<')
    const promoteAt = html.indexOf('>Promote<')
    const dismissAt = html.indexOf('>Dismiss<')
    expect(reviewAt).toBeGreaterThan(-1)
    expect(grillAt).toBeGreaterThan(reviewAt)
    expect(promoteAt).toBeGreaterThan(grillAt)
    expect(dismissAt).toBeGreaterThan(promoteAt)
  })

  it('Grill button carries an aria-label identifying the proposal', () => {
    const id = '894fbcdf-src-core-tests-timeout-handling'
    const html = render([draft({ id })])
    expect(html).toContain(`aria-label="Grill proposal ${id}"`)
  })

  it('Promote button carries an aria-label identifying the proposal', () => {
    const id = '894fbcdf-src-core-tests-timeout-handling'
    const html = render([draft({ id })])
    expect(html).toContain(`aria-label="Promote proposal ${id}"`)
  })

  it('does not render the old CopyButton for any proposal', () => {
    const longId = '894fbcdf-src-core-tests-src-cli-commands-tests-timeout-handling'
    const html = render([draft({ id: longId })])
    // The old copy button surface is gone — no aria-label referencing grill copy
    expect(html).not.toContain('Copy /mars:grill')
  })
})
