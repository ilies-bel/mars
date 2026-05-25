import { describe, expect, it } from 'bun:test'
import { DEFAULT_TAB, TABS, tabLabel, type Tab } from './tabs'

// `Tab` is imported so the test file is the consumer that proves the type
// is exported from the public module surface.
const _typeProbe: Tab = DEFAULT_TAB
void _typeProbe

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
  it('strip contains Board, Topology, and Events entries', () => {
    expect(TABS).toContain('board')
    expect(TABS).toContain('topology')
    expect(TABS).toContain('events')
  })

  it('board appears before topology in the strip', () => {
    expect(TABS.indexOf('board')).toBeLessThan(TABS.indexOf('topology'))
  })

  it('board appears before events in the strip', () => {
    expect(TABS.indexOf('board')).toBeLessThan(TABS.indexOf('events'))
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

  it('events tab carries the label "Events"', () => {
    expect(tabLabel('events')).toBe('Events')
  })
})

// ---------------------------------------------------------------------------
// Round-trip — every tab in the strip has a human label and the default
// tab is itself a member of the strip.
// ---------------------------------------------------------------------------

describe('tabs – round-trip', () => {
  it('every entry in the strip has a non-empty label', () => {
    for (const tab of TABS) {
      expect(tabLabel(tab).length).toBeGreaterThan(0)
    }
  })

  it('the default tab is one of the entries in the strip', () => {
    const known: readonly Tab[] = TABS
    expect(known).toContain(DEFAULT_TAB)
  })
})
