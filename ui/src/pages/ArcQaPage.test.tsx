/**
 * ArcQaPage component tests.
 *
 * Covers:
 *   - 404 / null case: shows "No QA walk recorded for this Arc."
 *   - Stopped-step badge: stopReason rendered on the stopped step only
 *   - Screenshot URL: correct /arc/:originId/qa/screenshot/:ci/:si pattern
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ArcQaPage } from './ArcQaPage'
import type { ArcQaData } from './ArcQaPage'

const ORIGIN_ID = 'task-abc123'

function makeQaData(overrides: Partial<ArcQaData> = {}): ArcQaData {
  return {
    criteria: overrides.criteria ?? [],
    stoppedAtStep: overrides.stoppedAtStep ?? null,
  }
}

function renderPage(data: ArcQaData | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData<ArcQaData | null>(['arc-qa', ORIGIN_ID], data)
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ArcQaPage originId={ORIGIN_ID} />
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// 404 / empty
// ---------------------------------------------------------------------------

describe('ArcQaPage — 404 / empty', () => {
  it('shows the no-record message when data is null (404 case)', () => {
    const html = renderPage(null)
    expect(html).toContain('No QA report exists for this arc.')
  })

  it('shows a heading and the arc id in the empty state', () => {
    const html = renderPage(null)
    expect(html).toContain('Arc QA')
    expect(html).toContain(ORIGIN_ID)
  })

  it('shows a link back to progress in the empty state', () => {
    const html = renderPage(null)
    expect(html).toContain('#/progress')
  })
})

// ---------------------------------------------------------------------------
// Stopped-step marker
// ---------------------------------------------------------------------------

describe('ArcQaPage — stopped-step marker', () => {
  beforeEach(() => vi.resetAllMocks())

  it('renders the stopReason badge on the stopped step', () => {
    const data = makeQaData({
      criteria: [
        {
          text: 'Criterion A',
          steps: [
            { index: 0, text: 'Step one' },
            { index: 1, text: 'Step two' },
          ],
        },
      ],
      stoppedAtStep: { criterionIndex: 0, stepIndex: 1, stopReason: 'assertion_failed' },
    })
    const html = renderPage(data)
    expect(html).toContain('assertion_failed')
  })

  it('renders the stopReason badge exactly once (not on other steps)', () => {
    const data = makeQaData({
      criteria: [
        {
          text: 'Criterion A',
          steps: [
            { index: 0, text: 'Step one' },
            { index: 1, text: 'Step two' },
          ],
        },
      ],
      stoppedAtStep: { criterionIndex: 0, stepIndex: 1, stopReason: 'assertion_failed' },
    })
    const html = renderPage(data)
    const matches = html.match(/assertion_failed/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('does not render any stopReason badge when stoppedAtStep is null', () => {
    const data = makeQaData({
      criteria: [
        {
          text: 'Criterion A',
          steps: [{ index: 0, text: 'Step one' }],
        },
      ],
      stoppedAtStep: null,
    })
    const html = renderPage(data)
    expect(html).not.toContain('data-testid="stop-reason-0-0"')
  })
})

// ---------------------------------------------------------------------------
// Empty criteria (arc exists but has no steps)
// ---------------------------------------------------------------------------

describe('ArcQaPage — empty criteria', () => {
  it('shows an empty-state message when arc has no QA steps', () => {
    const html = renderPage(makeQaData({ criteria: [] }))
    expect(html).toContain('No QA steps recorded for this arc.')
  })

  it('shows heading and arc id in the empty-criteria state', () => {
    const html = renderPage(makeQaData({ criteria: [] }))
    expect(html).toContain('Arc QA')
    expect(html).toContain(ORIGIN_ID)
  })

  it('does not show the "no report" message for empty criteria (arc exists)', () => {
    const html = renderPage(makeQaData({ criteria: [] }))
    expect(html).not.toContain('No QA report exists for this arc.')
  })
})

// ---------------------------------------------------------------------------
// Screenshot URL
// ---------------------------------------------------------------------------

describe('ArcQaPage — screenshot URL', () => {
  it('sources screenshots from /arc/:originId/qa/screenshot/:ci/:si', () => {
    const data = makeQaData({
      criteria: [
        {
          text: 'Criterion A',
          steps: [{ index: 0, text: 'First step' }],
        },
      ],
    })
    const html = renderPage(data)
    expect(html).toContain(`/arc/${ORIGIN_ID}/qa/screenshot/0/0`)
  })

  it('uses correct criterionIndex and stepIndex in the URL', () => {
    const data = makeQaData({
      criteria: [
        {
          text: 'Criterion A',
          steps: [
            { index: 0, text: 'Step one' },
            { index: 1, text: 'Step two' },
          ],
        },
        {
          text: 'Criterion B',
          steps: [{ index: 0, text: 'Step three' }],
        },
      ],
    })
    const html = renderPage(data)
    expect(html).toContain(`/arc/${ORIGIN_ID}/qa/screenshot/0/0`)
    expect(html).toContain(`/arc/${ORIGIN_ID}/qa/screenshot/0/1`)
    expect(html).toContain(`/arc/${ORIGIN_ID}/qa/screenshot/1/0`)
  })
})
