/**
 * Unit tests for StewardLedgerPanel — covers:
 *   - First-paint pagination (≤20 entries on initial render)
 *   - "Show more" affordance when entries exceed the cap
 *   - Outcome: JSON → human label (capitalised state) + disclosure element
 *   - Outcome: plain text → rendered verbatim, no disclosure
 *   - Rationale: wrapped in the markdown container div
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StewardLedgerPanel } from './StewardLedgerPanel'
import type { StewardLedgerEntry } from '@/shared/schemas'

// Response (Streamdown) is an interactive streaming renderer. In a static
// render context it is a no-op; stub it so tests stay focused on the
// StewardLedgerPanel behaviour rather than the markdown library internals.
vi.mock('@/components/ai-elements/response', () => ({
  Response: ({ children }: { children?: React.ReactNode }) =>
    createElement('span', { 'data-testid': 'response-stub' }, children),
}))

// displayStrings helpers — passthrough stubs so no date/sig logic interferes.
vi.mock('@/shared/displayStrings', () => ({
  smartTimestamp: (ts: string) => ts,
  formatFailureSig: (sig: string) => sig,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeEntry = (overrides: Partial<StewardLedgerEntry> = {}): StewardLedgerEntry => ({
  id: `entry-${Math.random().toString(36).slice(2)}`,
  ts: new Date().toISOString(),
  targetKind: 'worker',
  targetId: 'Coder',
  targetVersion: 'v1',
  recipeId: 'cap-tuning',
  rationale: 'Plain rationale text.',
  outcome: 'plain outcome',
  commitSha: null,
  ...overrides,
})

const render = (entries: StewardLedgerEntry[]): string => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(['steward-ledger', null, null], entries)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(StewardLedgerPanel)),
  )
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('StewardLedgerPanel — pagination', () => {
  it('renders all entries when count is within the 20-entry cap', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ id: `e${i}`, ts: new Date(1000 + i).toISOString() }),
    )
    const html = render(entries)
    const rows = html.match(/data-testid="steward-ledger-row"/g)
    expect(rows).toHaveLength(10)
    expect(html).not.toContain('data-testid="steward-ledger-show-more"')
  })

  it('caps initial render at 20 and shows a "Show more" button for 25 entries', () => {
    // Sort descending by ts in the component, so make ts distinct.
    const entries = Array.from({ length: 25 }, (_, i) =>
      makeEntry({ id: `e${i}`, ts: new Date(1000 + i).toISOString() }),
    )
    const html = render(entries)
    const rows = html.match(/data-testid="steward-ledger-row"/g)
    expect(rows).toHaveLength(20)
    expect(html).toContain('data-testid="steward-ledger-show-more"')
    expect(html).toContain('5 remaining')
  })

  it('renders exactly 20 entries when entries.length equals 20', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ id: `e${i}`, ts: new Date(1000 + i).toISOString() }),
    )
    const html = render(entries)
    const rows = html.match(/data-testid="steward-ledger-row"/g)
    expect(rows).toHaveLength(20)
    // Exactly at the cap: no "Show more" button (0 remaining).
    expect(html).not.toContain('data-testid="steward-ledger-show-more"')
  })
})

// ---------------------------------------------------------------------------
// Outcome field — JSON parsing and disclosure
// ---------------------------------------------------------------------------

describe('StewardLedgerPanel — outcome rendering', () => {
  it('shows capitalised state as the outcome label for a JSON outcome', () => {
    const entry = makeEntry({
      outcome: JSON.stringify({
        state: 'fixed',
        stewardId: 'steward-abc',
        signature: 'verify:worktree-missing/unclassified',
        streak: 3,
      }),
    })
    const html = render([entry])
    // The face value should be the capitalised state, not raw JSON.
    expect(html).toContain('data-testid="steward-outcome-label"')
    expect(html).toContain('>Fixed<')
    // The full JSON blob must be behind a disclosure, not on the primary face.
    expect(html).toContain('<details')
    expect(html).toContain('Technical details')
    expect(html).toContain('data-testid="steward-outcome-detail"')
    // Raw machine strings must not appear in the primary reading path.
    // They are inside the <details> block which starts with a <summary>.
    // The face of the label row contains "Fixed", not the raw JSON.
    const labelIdx = html.indexOf('steward-outcome-label')
    const detailsIdx = html.indexOf('<details')
    expect(labelIdx).toBeLessThan(detailsIdx)
  })

  it('shows the steward-id only inside the disclosure, not on the face', () => {
    const entry = makeEntry({
      outcome: JSON.stringify({ state: 'fixed', stewardId: 'steward-storm-ms9k3zsu' }),
    })
    const html = render([entry])
    // The summary/label part must not contain the raw id.
    // (The id lives inside <details>, which is after the label span.)
    const labelEnd = html.indexOf('</span>', html.indexOf('steward-outcome-label'))
    const machineIdIdx = html.indexOf('steward-storm-ms9k3zsu')
    expect(machineIdIdx).toBeGreaterThan(labelEnd)
  })

  it('renders plain-text outcome verbatim without a disclosure', () => {
    const entry = makeEntry({ outcome: 'applied' })
    const html = render([entry])
    expect(html).toContain('>applied<')
    // No <details> element for a plain-text outcome that is not JSON.
    expect(html).not.toContain('<details')
  })

  it('handles a JSON outcome object that has no state key gracefully', () => {
    const entry = makeEntry({
      outcome: JSON.stringify({ kind: 'noop', reason: 'already optimal' }),
    })
    const html = render([entry])
    // Falls back to "Done" when no state field.
    expect(html).toContain('>Done<')
    expect(html).toContain('<details')
  })
})

// ---------------------------------------------------------------------------
// Rationale field — markdown wrapper
// ---------------------------------------------------------------------------

describe('StewardLedgerPanel — rationale rendering', () => {
  it('wraps the rationale in the markdown container', () => {
    const entry = makeEntry({ rationale: '## Root cause\n\n**Bold** explanation.' })
    const html = render([entry])
    expect(html).toContain('data-testid="steward-rationale-markdown"')
    // The Response stub renders the content inside it.
    expect(html).toContain('data-testid="response-stub"')
    // The raw markdown source must not be rendered as literal symbols.
    // "##" and "**" are inside the Response component (which would normally
    // convert them); in this test the stub passes them through, but the
    // important invariant is that the markdown wrapper div is always present.
    expect(html).toContain('chat-markdown')
  })

  it('renders the empty state when no entries are loaded', () => {
    const html = render([])
    expect(html).toContain('data-testid="steward-ledger-empty"')
    expect(html).not.toContain('data-testid="steward-ledger-row"')
  })
})
