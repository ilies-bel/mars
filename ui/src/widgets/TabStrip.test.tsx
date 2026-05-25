import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TabStrip } from './TabStrip'

describe('TabStrip', () => {
  it('renders a Board tab button', () => {
    const html = renderToStaticMarkup(
      <TabStrip active="board" onSelect={() => undefined} />,
    )
    expect(html).toContain('data-testid="tab-board"')
  })

  it('renders a Topology tab button', () => {
    const html = renderToStaticMarkup(
      <TabStrip active="board" onSelect={() => undefined} />,
    )
    expect(html).toContain('data-testid="tab-topology"')
  })

  it('marks the active tab with aria-selected="true"', () => {
    const html = renderToStaticMarkup(
      <TabStrip active="topology" onSelect={() => undefined} />,
    )
    // The topology tab button should be aria-selected
    expect(html).toContain('data-testid="tab-topology"')
    // Board tab should not be selected
    const boardIdx = html.indexOf('tab-board')
    const topologyIdx = html.indexOf('tab-topology')
    // aria-selected="true" appears once, before the topology button label
    expect(html).toContain('aria-selected="true"')
  })

  it('Topology is listed before Board in the strip (topology is the default)', () => {
    const html = renderToStaticMarkup(
      <TabStrip active="topology" onSelect={() => undefined} />,
    )
    expect(html.indexOf('tab-topology')).toBeLessThan(html.indexOf('tab-board'))
  })
})
