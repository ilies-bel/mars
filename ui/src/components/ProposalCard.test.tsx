import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProposalCard } from './ProposalCard'
import type { DraftFeature } from '@/shared/schemas'

const draft = (overrides: Partial<DraftFeature> = {}): DraftFeature => ({
  id: 'prop-abc-123',
  title: 'Surface proposals in the Progress board',
  problem: '',
  solution: '',
  status: 'draft',
  source: 'human',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  acceptanceCount: 0,
  userStories: [],
  ...overrides,
} as DraftFeature)

describe('ProposalCard', () => {
  it('renders an anchor linking to #/proposal/<id>', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('href="#/proposal/prop-abc-123"')
  })

  it('shows the proposal title as the title text', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('Surface proposals in the Progress board')
  })

  it('clamps a long title with CSS rather than a hard character cut', () => {
    // Previously the title was cut at 120 chars with `truncate()`, which sliced
    // mid-word and dropped the tail from the DOM. A CSS clamp keeps the full
    // title available to search and screen readers while bounding the card —
    // and matches the treatment on ProposalsPage.
    const long = 'A very long legacy title that used to be a whole prose document. '.repeat(10)
    const html = renderToStaticMarkup(<ProposalCard proposal={draft({ title: long })} />)

    expect(html).toContain('line-clamp-2')
    expect(html).not.toContain('…')
    expect(html).toContain('whole prose document.')
  })

  it('URL-encodes special characters in the proposal id', () => {
    const html = renderToStaticMarkup(
      <ProposalCard proposal={draft({ id: 'prop/special id' })} />,
    )
    expect(html).toContain('href="#/proposal/prop%2Fspecial%20id"')
  })
})

describe('ProposalCard – whole-card clickability', () => {
  it('signals full-card clickability via cursor-pointer', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('cursor-pointer')
  })
})

describe('ProposalCard – keyboard operability', () => {
  it('is keyboard-focusable via tabIndex=0', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('tabindex="0"')
  })

  it('has role=button so assistive technology treats it as pressable', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('role="button"')
  })
})

describe('ProposalCard – focus-visible ring', () => {
  it('suppresses the default outline in favour of a custom ring', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('')
  })

  it('applies the semantic ring token for keyboard navigation', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('')
    expect(html).toContain('')
  })
})
