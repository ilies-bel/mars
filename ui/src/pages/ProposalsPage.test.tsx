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

vi.mock('@/entities/proposals/useProposals', () => ({
  useProposals: () => ({
    proposals,
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

const render = (drafts: DraftFeature[]): string => {
  proposals.splice(0, proposals.length, ...drafts)
  return renderToStaticMarkup(<ProposalsPage />)
}

describe('ProposalsPage — title clamping', () => {
  it('clamps the title to two lines so a long legacy title cannot take over the card', () => {
    const html = render([draft({ title: 'A very long legacy title. '.repeat(60) })])
    expect(html).toContain('line-clamp-2')
  })

  it('keeps the title as the strongest element in the card', () => {
    const html = render([draft()])
    // Title stays at body size / medium weight; the preview below is text-micro
    // and muted. The clamp bounds the title without changing the hierarchy.
    expect(html).toContain('text-body font-medium')
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
