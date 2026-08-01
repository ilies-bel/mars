import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryBoundaryLine } from './MemoryBoundaryLine'

describe('MemoryBoundaryLine', () => {
  it('identifies where Mars can read instead of presenting another Subthread boundary', () => {
    const html = renderToStaticMarkup(<MemoryBoundaryLine />)

    expect(html).toContain('Mars can read from here')
    expect(html).toContain('data-testid="memory-boundary-line"')
    expect(html).toContain('role="separator"')
    expect(html).not.toContain('Subthread boundary')
  })
})
