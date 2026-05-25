import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ALL_CLUSTER_TOGGLES,
  ClusterToggleBar,
  type ClusterToggle,
} from './ClusterToggleBar'

describe('ClusterToggleBar – four controls', () => {
  it('renders a Proposal toggle', () => {
    const html = renderToStaticMarkup(
      <ClusterToggleBar active={new Set(ALL_CLUSTER_TOGGLES)} onToggle={() => undefined} />,
    )
    expect(html).toContain('data-testid="toggle-proposal"')
  })

  it('renders an In-progress toggle', () => {
    const html = renderToStaticMarkup(
      <ClusterToggleBar active={new Set(ALL_CLUSTER_TOGGLES)} onToggle={() => undefined} />,
    )
    expect(html).toContain('data-testid="toggle-in-progress"')
  })

  it('renders a Blocked toggle', () => {
    const html = renderToStaticMarkup(
      <ClusterToggleBar active={new Set(ALL_CLUSTER_TOGGLES)} onToggle={() => undefined} />,
    )
    expect(html).toContain('data-testid="toggle-blocked"')
  })

  it('renders a Failed toggle', () => {
    const html = renderToStaticMarkup(
      <ClusterToggleBar active={new Set(ALL_CLUSTER_TOGGLES)} onToggle={() => undefined} />,
    )
    expect(html).toContain('data-testid="toggle-failed"')
  })
})

describe('ClusterToggleBar – default on state', () => {
  it('marks all four toggles as checked when all are active', () => {
    const html = renderToStaticMarkup(
      <ClusterToggleBar active={new Set(ALL_CLUSTER_TOGGLES)} onToggle={() => undefined} />,
    )
    const trueCount = (html.match(/aria-checked="true"/g) ?? []).length
    expect(trueCount).toBe(4)
  })

  it('ALL_CLUSTER_TOGGLES contains exactly the four expected clusters', () => {
    expect(ALL_CLUSTER_TOGGLES).toContain('Proposal')
    expect(ALL_CLUSTER_TOGGLES).toContain('In progress')
    expect(ALL_CLUSTER_TOGGLES).toContain('Blocked')
    expect(ALL_CLUSTER_TOGGLES).toContain('Failed')
    expect(ALL_CLUSTER_TOGGLES).toHaveLength(4)
  })
})

describe('ClusterToggleBar – off state', () => {
  it('marks a turned-off cluster as aria-checked=false', () => {
    const active = new Set<ClusterToggle>(['Proposal', 'In progress', 'Blocked'])
    const html = renderToStaticMarkup(
      <ClusterToggleBar active={active} onToggle={() => undefined} />,
    )
    const falseCount = (html.match(/aria-checked="false"/g) ?? []).length
    const trueCount = (html.match(/aria-checked="true"/g) ?? []).length
    expect(falseCount).toBe(1)
    expect(trueCount).toBe(3)
  })

  it('marks all toggles as unchecked when active set is empty', () => {
    const html = renderToStaticMarkup(
      <ClusterToggleBar active={new Set()} onToggle={() => undefined} />,
    )
    const falseCount = (html.match(/aria-checked="false"/g) ?? []).length
    expect(falseCount).toBe(4)
  })
})
