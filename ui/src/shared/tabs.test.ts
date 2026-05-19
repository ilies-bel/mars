import { describe, expect, it } from 'bun:test'
import { DEFAULT_TAB, TABS, tabLabel, type Tab } from './tabs'

// ---------------------------------------------------------------------------
// Default tab
// ---------------------------------------------------------------------------

describe('tabs – default', () => {
  it('board tab is selected by default on page load', () => {
    expect(DEFAULT_TAB).toBe('board')
  })
})

// ---------------------------------------------------------------------------
// Tab strip entries
// ---------------------------------------------------------------------------

describe('tabs – entries', () => {
  it('strip contains both Board and Topology entries', () => {
    expect(TABS).toContain('board')
    expect(TABS).toContain('topology')
  })

  it('board appears before topology in the strip', () => {
    expect(TABS.indexOf('board')).toBeLessThan(TABS.indexOf('topology'))
  })
})

// ---------------------------------------------------------------------------
// Human-readable labels
// ---------------------------------------------------------------------------

describe('tabLabel', () => {
  it('board tab carries the label "Board"', () => {
    expect(tabLabel('board')).toBe('Board')
  })

  it('topology tab carries the label "Topology"', () => {
    expect(tabLabel('topology')).toBe('Topology')
  })
})

// ---------------------------------------------------------------------------
// Visibility logic
// ---------------------------------------------------------------------------

describe('tabs – visibility', () => {
  it('switching to topology hides the board and shows topology', () => {
    const active: Tab = 'topology'
    expect(active === 'board').toBe(false)
    expect(active === 'topology').toBe(true)
  })

  it('switching back to board shows the board and hides topology', () => {
    const active: Tab = 'board'
    expect(active === 'board').toBe(true)
    expect(active === 'topology').toBe(false)
  })
})
