/**
 * Shell component tests.
 *
 * ShellSidebar is tested directly with controlled props (no hooks) to verify:
 *   - active route is highlighted (aria-current, flame bg, right-edge accent, amber text)
 *   - Chat badge appears only when decisionBadge > 0
 *   - no badge on any other nav entry
 *
 * Shell is tested via renderToStaticMarkup with mocked hooks to verify:
 *   - three group headers are rendered
 *   - all nine nav entry labels are rendered
 *   - wordmark and live-dot placeholder are present
 */

import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// ── Module mocks — must be registered before any import of the component ─────

mock.module('@/entities/stale-worktrees/useStaleWorktrees', () => ({
  useStaleWorktrees: () => ({
    staleWorktrees: [],
    isPending: false,
    error: null,
    connected: false,
  }),
}))

// ProjectSelector pulls in providers; stub it out for unit tests.
mock.module('@/widgets/ProjectSelector', () => ({
  ProjectSelector: () => null,
}))

// ── Import after mocks are registered ────────────────────────────────────────

const { Shell, ShellSidebar, SHELL_NAV_GROUPS } = await import('./Shell')

// ── SHELL_NAV_GROUPS ──────────────────────────────────────────────────────────

describe('SHELL_NAV_GROUPS', () => {
  it('defines exactly three groups', () => {
    expect(SHELL_NAV_GROUPS).toHaveLength(3)
  })

  it('names the groups Workspace, Developer, Intel in order', () => {
    expect(SHELL_NAV_GROUPS[0].label).toBe('Workspace')
    expect(SHELL_NAV_GROUPS[1].label).toBe('Developer')
    expect(SHELL_NAV_GROUPS[2].label).toBe('Intel')
  })

  it('has nine total nav entries across all groups', () => {
    const total = SHELL_NAV_GROUPS.reduce((sum, g) => sum + g.entries.length, 0)
    expect(total).toBe(9)
  })

  it('Workspace group contains Chat, Progress, Control Room', () => {
    const workspace = SHELL_NAV_GROUPS[0]
    const labels = workspace.entries.map((e) => e.label)
    expect(labels).toContain('Chat')
    expect(labels).toContain('Progress')
    expect(labels).toContain('Control Room')
  })

  it('Developer group contains Studio, Events, Reflections, Steward', () => {
    const dev = SHELL_NAV_GROUPS[1]
    const labels = dev.entries.map((e) => e.label)
    expect(labels).toContain('Studio')
    expect(labels).toContain('Events')
    expect(labels).toContain('Reflections')
    expect(labels).toContain('Steward')
  })

  it('Intel group contains KPI and Proposals', () => {
    const intel = SHELL_NAV_GROUPS[2]
    const labels = intel.entries.map((e) => e.label)
    expect(labels).toContain('KPI')
    expect(labels).toContain('Proposals')
  })
})

// ── ShellSidebar — active state ───────────────────────────────────────────────

describe('ShellSidebar — active state', () => {
  it('marks the active route with aria-current="page"', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    expect(html).toContain('aria-current="page"')
  })

  it('applies only one aria-current="page" regardless of how many entries match', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="progress" decisionBadge={0} />)
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })

  it('applies flame-tinted background class to the active entry', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="progress" decisionBadge={0} />)
    expect(html).toContain('bg-highlight/20')
  })

  it('applies right-edge accent via border-r-2 and border-highlight', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="events" decisionBadge={0} />)
    expect(html).toContain('border-r-2')
    expect(html).toContain('border-highlight')
  })

  it('applies amber text color via inline style to the active entry', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    expect(html).toContain('var(--color-amber)')
  })

  it('does NOT apply amber inline style to inactive entries', () => {
    // When chat is active, progress should have no amber style
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    // Only one occurrence of the amber style (the active entry)
    const amberMatches = html.match(/var\(--color-amber\)/g)
    expect(amberMatches).toHaveLength(1)
  })

  it('proposals entry never has aria-current="page" even when route is progress', () => {
    // Proposals links to #/progress but must never be highlighted as active
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="progress" decisionBadge={0} />)
    // Only Progress (route='progress') should have aria-current, not Proposals
    // There should be exactly one aria-current="page"
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })
})

// ── ShellSidebar — Chat badge ─────────────────────────────────────────────────

describe('ShellSidebar — Chat badge', () => {
  it('shows a numeric badge on Chat when decisionBadge > 0', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="progress" decisionBadge={3} />)
    expect(html).toContain('>3<')
  })

  it('caps badge display at 99+ when count exceeds 99', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={100} />)
    expect(html).toContain('>99+<')
    expect(html).not.toContain('>100<')
  })

  it('shows no badge span when decisionBadge is 0', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    expect(html).not.toContain('decisions pending')
  })

  it('renders the badge only once (on Chat, not on other entries)', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={5} />)
    const badgeMatches = html.match(/decisions pending/g)
    expect(badgeMatches).toHaveLength(1)
  })

  it('badge is labelled for screen readers', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={7} />)
    expect(html).toContain('aria-label="7 decisions pending"')
  })
})

// ── Shell — structure ─────────────────────────────────────────────────────────

describe('Shell', () => {
  it('renders all three group headers', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('Workspace')
    expect(html).toContain('Developer')
    expect(html).toContain('Intel')
  })

  it('renders all nine nav entry labels', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    const allLabels = SHELL_NAV_GROUPS.flatMap((g) => g.entries.map((e) => e.label))
    for (const label of allLabels) {
      expect(html).toContain(label)
    }
  })

  it('renders the ◆ mars wordmark', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('◆ mars')
  })

  it('renders the static live-dot placeholder', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('data-testid="shell-live-dot"')
  })

  it('renders the children in the content area', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat"><p>hello world</p></Shell>)
    expect(html).toContain('<p>hello world</p>')
  })

  it('highlights the route derived from the hash', () => {
    const html = renderToStaticMarkup(<Shell hash="#/events">page</Shell>)
    // Events entry should be active
    expect(html).toContain('aria-current="page"')
    // The bg-highlight/20 class should appear on the active entry
    expect(html).toContain('bg-highlight/20')
  })
})
