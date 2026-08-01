import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubthreadBoundaryLine } from './SubthreadBoundaryLine'

describe('SubthreadBoundaryLine', () => {
  it('shows a closed Subthread’s aggregate production and carried context at its end seam', () => {
    const html = renderToStaticMarkup(
      <SubthreadBoundaryLine
        boundary={{
          subthreadId: 'investigation',
          startedAt: '2026-08-01T10:00:00.000Z',
          closedAt: '2026-08-01T10:05:00.000Z',
          producedTokens: 1250,
          carriedTokens: 5400,
        }}
        position="end"
      />,
    )

    expect(html).toContain('Subthread complete')
    expect(html).toContain('1,250 produced')
    expect(html).toContain('5,400 carried')
    expect(html).toContain('data-testid="subthread-boundary-end"')
  })
})
