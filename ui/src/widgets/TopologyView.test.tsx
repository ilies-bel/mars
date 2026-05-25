import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TopologyView } from './TopologyView'

describe('TopologyView', () => {
  it('renders a topology placeholder when the Topology tab is active', () => {
    const html = renderToStaticMarkup(<TopologyView />)
    expect(html.length).toBeGreaterThan(0)
  })

  it('indicates it is the topology view so the operator can identify the panel', () => {
    const html = renderToStaticMarkup(<TopologyView />)
    expect(html.toLowerCase()).toContain('topology')
  })
})
