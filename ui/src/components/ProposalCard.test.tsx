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
    expect(html).toContain('focus-visible:outline-none')
  })

  it('applies a flame-coloured focus ring for keyboard navigation', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('focus-visible:ring-2')
    expect(html).toContain('focus-visible:ring-flame')
  })
})
