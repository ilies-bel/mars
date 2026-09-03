import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProposalActionRow } from './ProposalActionRow'

describe('ProposalActionRow', () => {
  it('renders the action row container with the correct testid', () => {
    const html = renderToStaticMarkup(
      <ProposalActionRow proposalId="prop-1" status="draft" />,
    )
    expect(html).toContain('data-testid="proposal-action-row"')
  })

  it('renders all five action buttons in idle state', () => {
    const html = renderToStaticMarkup(
      <ProposalActionRow proposalId="prop-1" status="draft" />,
    )
    expect(html).toContain('data-testid="btn-promote"')
    expect(html).toContain('data-testid="btn-grill"')
    expect(html).toContain('data-testid="btn-mockup"')
    expect(html).toContain('data-testid="btn-implement-live"')
    expect(html).toContain('data-testid="btn-dismiss"')
  })

  it('renders correct idle labels for each button', () => {
    const html = renderToStaticMarkup(
      <ProposalActionRow proposalId="prop-1" status="draft" />,
    )
    expect(html).toContain('Promote')
    expect(html).toContain('Grill')
    expect(html).toContain('Mockup')
    expect(html).toContain('Implement live')
    expect(html).toContain('Dismiss')
  })

  it('accepts an optional onDismissed callback without rendering errors', () => {
    const html = renderToStaticMarkup(
      <ProposalActionRow
        proposalId="prop-2"
        status="draft"
        onDismissed={() => {}}
      />,
    )
    expect(html).toContain('data-testid="btn-dismiss"')
  })

  it('accepts an optional onClose callback without rendering errors', () => {
    const html = renderToStaticMarkup(
      <ProposalActionRow
        proposalId="prop-3"
        status="draft"
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-testid="btn-grill"')
  })

  it('does not show error or done states on initial render', () => {
    const html = renderToStaticMarkup(
      <ProposalActionRow proposalId="prop-1" status="draft" />,
    )
    expect(html).not.toContain('Promoted')
    expect(html).not.toContain('Dismissed')
    expect(html).not.toContain('Mockup queued')
    expect(html).not.toContain('Live task')
    expect(html).not.toContain('data-testid="grill-error"')
    expect(html).not.toContain('text-destructive')
  })
})
