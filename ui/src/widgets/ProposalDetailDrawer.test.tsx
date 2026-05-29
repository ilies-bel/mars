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

// ── Drawer entrance animation ────────────────────────────────────────────────

describe('ProposalDetailDrawer – entrance / exit animation structure', () => {
  it('aside panel carries the drawer-panel CSS class (entrance animation anchor)', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('drawer-panel')
  })

  it('scrim carries the drawer-scrim CSS class (scrim fade anchor)', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('drawer-scrim')
  })

  it('data-closing is absent on initial render — exit animation not yet active', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).not.toContain('data-closing="true"')
  })
})

// ── A11y: scrim + focusable drawer ───────────────────────────────────────────

/**
 * Same structural checks as TaskDetailDrawer – the two drawers share the same
 * a11y contract (scrim, focus-trap infrastructure, Escape-to-close).
 */
describe('ProposalDetailDrawer – a11y overlay and focusability', () => {
  it('renders a scrim overlay element alongside the drawer panel', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="proposal-detail-overlay"')
  })

  it('scrim is aria-hidden so it does not pollute the screen reader tree', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('aria-hidden="true"')
  })

  it('scrim uses z-40 (lower than the drawer z-50) so the drawer stays on top', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('z-40')
    expect(html).toContain('z-50')
  })

  it('drawer panel has tabindex="-1" so it can receive programmatic focus on open', () => {
    const html = renderToStaticMarkup(
      <ProposalDetailDrawer proposal={draftProposal()} onClose={() => {}} />,
    )
    expect(html).toContain('tabindex="-1"')
  })
})
