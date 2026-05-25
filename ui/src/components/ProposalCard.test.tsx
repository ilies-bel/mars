import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProposalCard } from './ProposalCard'
import type { DraftFeature } from '@/shared/schemas'

const draft = (overrides: Partial<DraftFeature> = {}): DraftFeature => ({
  id: 'prop-abc-123',
  goal: 'Surface proposals in the Progress board',
  story: '',
  technical: '',
  status: 'draft',
  source: 'human',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  acceptanceCount: 0,
  ...overrides,
})

describe('ProposalCard', () => {
  it('renders an anchor linking to #/proposal/<id>', () => {
    const html = renderToStaticMarkup(<ProposalCard proposal={draft()} />)
    expect(html).toContain('href="#/proposal/prop-abc-123"')
  })

  it('shows the proposal goal as the title text', () => {
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
