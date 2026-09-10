/**
 * Tests for the EmptyState shared component.
 *
 * Key invariants:
 *   - The title always renders, so an empty region reads as a statement of
 *     fact rather than as a blank that might be a bug.
 *   - `children` and `action` are both optional and render nothing at all
 *     when omitted — no empty <p>, no stray spacer div.
 *   - Both variants forward `data-testid`, because the pages that adopted
 *     this component kept their existing per-page test handles.
 *   - The two variants differ in alignment: `pane` centres, `inline` does not.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the title on its own', () => {
    const html = renderToStaticMarkup(<EmptyState title="All quiet" />)
    expect(html).toContain('All quiet')
  })

  it('omits the body and the action when neither is supplied', () => {
    const html = renderToStaticMarkup(<EmptyState title="All quiet" />)
    // One <p> — the title. A body paragraph would make it two.
    expect(html.split('<p').length - 1).toBe(1)
  })

  it('renders the body when supplied', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No scored runs yet">Accept a scorer to begin.</EmptyState>,
    )
    expect(html).toContain('No scored runs yet')
    expect(html).toContain('Accept a scorer to begin.')
  })

  it('renders the action when supplied', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No matches" action={<button type="button">Clear filters</button>} />,
    )
    expect(html).toContain('Clear filters')
  })

  it('forwards data-testid in both variants', () => {
    const pane = renderToStaticMarkup(<EmptyState title="x" data-testid="pane-id" />)
    const inline = renderToStaticMarkup(
      <EmptyState title="x" variant="inline" data-testid="inline-id" />,
    )
    expect(pane).toContain('data-testid="pane-id"')
    expect(inline).toContain('data-testid="inline-id"')
  })

  it('centres the pane variant and left-aligns the inline one', () => {
    const pane = renderToStaticMarkup(<EmptyState title="x" />)
    const inline = renderToStaticMarkup(<EmptyState title="x" variant="inline" />)
    expect(pane).toContain('text-center')
    expect(inline).not.toContain('text-center')
    expect(inline).toContain('items-start')
  })

  it('defaults data-testid to empty-state', () => {
    const html = renderToStaticMarkup(<EmptyState title="x" />)
    expect(html).toContain('data-testid="empty-state"')
  })
})
