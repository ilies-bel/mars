import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProposalDetailDrawer } from './ProposalDetailDrawer'
import type { DraftFeature } from '@/shared/schemas'

const draftProposal = (overrides: Partial<DraftFeature> = {}): DraftFeature => ({
  id: 'prop-1',
  title: 'Fill in the Proposal drawer content',
  problem: '',
  solution: '',
  status: 'draft',
  source: 'reflection',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  acceptanceCount: 3,
  ...overrides,
})

describe('ProposalDetailDrawer', () => {
  it('renders the proposal title, status badge, and source', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )

    // Title at the top of the drawer.
    expect(html).toContain('Fill in the Proposal drawer content')

    // Status badge reflects the draft status with legend-matching styling.
    expect(html).toContain('data-testid="proposal-detail-status"')
    expect(html).toContain('draft')
    expect(html).toContain('font-mono')

    // Source label is visible.
    expect(html).toContain('data-testid="proposal-detail-source"')
    expect(html).toContain('reflection')
  })

  it('reflects a non-draft status and a different source', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer
        proposal={draftProposal({ status: 'prd-ready', source: 'planner' })}
        onClose={() => {}}
      />,
    )

    expect(html).toContain('prd-ready')
    expect(html).toContain('planner')
  })
})
