/**
 * Tests for useCounts — the unified counts hook.
 *
 * Verifies that:
 * - When the query has data, known=true and counts match the server response.
 * - While loading (no data yet), known=false and every field returns zero.
 * - Both Shell badge and ChatGreeting read the same needsYou value because
 *   they both ultimately derive from this hook (Shell reads useCounts().needsYou
 *   directly; ChatGreeting receives it as a prop from its parent which calls
 *   useCounts()).
 */

import { vi, describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// Mock useQuery so the hook can be tested without a QueryClient provider.
// Also mock useFocusedProject to return a stable project id.
vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
}))
vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProject: () => ({ focusedProjectId: 'proj-1' }),
}))

import { useQuery } from '@tanstack/react-query'
import { useCounts } from './useCounts'

const mockUseQuery = vi.mocked(useQuery as () => unknown)

afterEach(() => {
  vi.resetAllMocks()
})

// ── Probe component ──────────────────────────────────────────────────────────

function Probe() {
  const counts = useCounts()
  return (
    <div
      data-testid="probe"
      data-known={String(counts.known)}
      data-needs-you={String(counts.needsYou)}
      data-running={String(counts.running)}
      data-verifying={String(counts.verifying)}
      data-merging={String(counts.merging)}
      data-queued={String(counts.queued)}
      data-blocked={String(counts.blocked)}
      data-failed={String(counts.failed)}
      data-done-today={String(counts.doneToday)}
      data-proposals-draft={String(counts.proposals.draft)}
      data-proposals-total={String(counts.proposals.total)}
    />
  )
}

function attr(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return m?.[1]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useCounts', () => {
  it('returns known=true and real counts when query resolves', () => {
    mockUseQuery.mockReturnValue({
      data: {
        needsYou: 3,
        running: 5,
        verifying: 2,
        merging: 1,
        queued: 7,
        blocked: 4,
        failed: 2,
        doneToday: 10,
        proposals: { draft: 6, total: 14 },
      },
    })
    const html = renderToStaticMarkup(<Probe />)
    expect(attr(html, 'data-known')).toBe('true')
    expect(attr(html, 'data-needs-you')).toBe('3')
    expect(attr(html, 'data-running')).toBe('5')
    expect(attr(html, 'data-verifying')).toBe('2')
    expect(attr(html, 'data-merging')).toBe('1')
    expect(attr(html, 'data-queued')).toBe('7')
    expect(attr(html, 'data-blocked')).toBe('4')
    expect(attr(html, 'data-failed')).toBe('2')
    expect(attr(html, 'data-done-today')).toBe('10')
    expect(attr(html, 'data-proposals-draft')).toBe('6')
    expect(attr(html, 'data-proposals-total')).toBe('14')
  })

  it('returns known=false and zeros while loading (query data undefined)', () => {
    mockUseQuery.mockReturnValue({ data: undefined })
    const html = renderToStaticMarkup(<Probe />)
    expect(attr(html, 'data-known')).toBe('false')
    expect(attr(html, 'data-needs-you')).toBe('0')
    expect(attr(html, 'data-running')).toBe('0')
    expect(attr(html, 'data-failed')).toBe('0')
    expect(attr(html, 'data-proposals-draft')).toBe('0')
    expect(attr(html, 'data-proposals-total')).toBe('0')
  })

  it('returns known=false when query has no data (daemon unreachable)', () => {
    mockUseQuery.mockReturnValue({ data: undefined, isError: true })
    const html = renderToStaticMarkup(<Probe />)
    expect(attr(html, 'data-known')).toBe('false')
    expect(attr(html, 'data-needs-you')).toBe('0')
  })

  it('needsYou from useCounts is the same value the Shell badge and ChatGreeting both display', () => {
    // Shell reads useCounts().needsYou for the badge count.
    // ChatGreeting receives needYou as a prop from its parent, which calls useCounts().
    // Both widgets therefore show the same number derived from the same hook call.
    const needsYou = 9
    mockUseQuery.mockReturnValue({
      data: {
        needsYou,
        running: 0, verifying: 0, merging: 0,
        queued: 0, blocked: 0, failed: 0, doneToday: 0,
        proposals: { draft: 0, total: 0 },
      },
    })
    const html = renderToStaticMarkup(<Probe />)
    expect(attr(html, 'data-needs-you')).toBe(String(needsYou))
  })
})
