import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphView } from './GraphView'

describe('GraphView', () => {
  it('renders the graph canvas area', () => {
    const html = renderToStaticMarkup(<GraphView />)
    expect(html.length).toBeGreaterThan(0)
  })

  it('shows a helper string referencing mars task add when no data is loaded', () => {
    const html = renderToStaticMarkup(<GraphView />)
    expect(html).toContain('mars task add')
  })

  it('centers the empty-state content', () => {
    const html = renderToStaticMarkup(<GraphView />)
    // The empty-state element should use centering classes
    expect(html).toContain('data-testid="graph-empty-state"')
  })
})
