import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubjectBoundaryLine } from './SubjectBoundaryLine'

describe('SubjectBoundaryLine', () => {
  it('shows a closed Subject’s aggregate production and carried context at its end seam', () => {
    const html = renderToStaticMarkup(
      <SubjectBoundaryLine
        boundary={{
          subjectId: 'investigation',
          startedAt: '2026-08-01T10:00:00.000Z',
          closedAt: '2026-08-01T10:05:00.000Z',
          producedTokens: 1250,
          carriedTokens: 5400,
        }}
        position="end"
      />,
    )

    expect(html).toContain('Subject complete')
    expect(html).toContain('1,250 produced')
    expect(html).toContain('5,400 carried')
    expect(html).toContain('data-testid="subject-boundary-end"')
  })
})
