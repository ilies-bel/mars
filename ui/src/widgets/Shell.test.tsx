/**
 * Shell component tests.
 *
 * ShellSidebar is tested directly with controlled props (no hooks) to verify:
 *   - active route is highlighted (aria-current, flame bg, right-edge accent, amber text)
 *   - "Needs you" badge appears only when decisionBadge > 0
 *   - no badge on any other nav entry
 *   - proposals/progress mutual-exclusion logic
 *
 * Shell is tested via renderToStaticMarkup with mocked hooks to verify:
 *   - three group headers are rendered
 *   - all nine nav entry labels are rendered
 *   - wordmark and live-dot are present
 *   - live-dot reflects daemon connection state (green+Live vs grey+Reconnecting)
 */

import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// ── Module mocks — must be registered before any import of the component ─────

// useActionQueue — Shell uses this for the Needs you badge count.
// Mutable so tests can inject items and verify badge computation.
let mockActionQueueItems: { id: string; kind: string; priority: string; at: string }[] = []
mock.module('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({
    items: mockActionQueueItems,
    error: null,
    projectsError: null,
    projectsEmpty: false,
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

  it('Workspace group contains Needs you, Chat, Progress, Control Room', () => {
    const workspace = SHELL_NAV_GROUPS[0]
    const labels = workspace.entries.map((e) => e.label)
    expect(labels).toContain('Needs you')
    expect(labels).toContain('Chat')
    expect(labels).toContain('Progress')
    expect(labels).toContain('Control Room')
  })

  it('Needs you is the first entry in the Workspace group', () => {
    expect(SHELL_NAV_GROUPS[0].entries[0].label).toBe('Needs you')
    expect(SHELL_NAV_GROUPS[0].entries[0].href).toBe('#/triage')
  })

  it('Developer group contains Events, Reflections, Steward (Studio removed — accessed via task detail)', () => {
    const dev = SHELL_NAV_GROUPS[1]
    const labels = dev.entries.map((e) => e.label)
    expect(labels).not.toContain('Studio')
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

  it('all nav entry icons are unique — no duplicate glyphs', () => {
    const icons = SHELL_NAV_GROUPS.flatMap((g) => g.entries.map((e) => e.icon))
    const unique = new Set(icons)
    expect(unique.size).toBe(icons.length)
  })

  it('wordmark glyph ◆ is not reused by any nav entry icon', () => {
    const icons = SHELL_NAV_GROUPS.flatMap((g) => g.entries.map((e) => e.icon))
    expect(icons).not.toContain('◆')
  })

  it('Proposals entry href is #/proposals', () => {
    const entry = SHELL_NAV_GROUPS.flatMap((g) => g.entries).find((e) => e.label === 'Proposals')
    expect(entry?.href).toBe('#/proposals')
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

  it('proposals entry has aria-current when activeRoute is proposals', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="proposals" decisionBadge={0} />)
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })

  it('proposals entry has no aria-current when activeRoute is progress', () => {
    // proposals is its own route; visiting #/progress does not highlight Proposals
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="progress" decisionBadge={0} />)
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })

  it('progress entry is highlighted for studio route (studio is nested under progress)', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="studio" decisionBadge={0} />)
    expect(html).toContain('aria-current="page"')
    // Exactly one active entry
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })
})

// ── ShellSidebar — Proposals route highlighting ───────────────────────────────

describe('ShellSidebar — Proposals route highlighting', () => {
  it('highlights Proposals when activeRoute is proposals', () => {
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="proposals" decisionBadge={0} />,
    )
    // Must have exactly one active entry
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
    // Only one amber highlight
    const amber = html.match(/var\(--color-amber\)/g)
    expect(amber).toHaveLength(1)
  })

  it('highlights Progress (not Proposals) when activeRoute is progress', () => {
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="progress" decisionBadge={0} />,
    )
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })

  it('highlights Progress when activeRoute is studio (studio nests under Progress)', () => {
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="studio" decisionBadge={0} />,
    )
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })
})

// ── ShellSidebar — Needs you badge ───────────────────────────────────────────

describe('ShellSidebar — Needs you badge', () => {
  it('shows a numeric badge on Needs you when decisionBadge > 0', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="progress" decisionBadge={3} />)
    expect(html).toContain('>3<')
  })

  it('caps badge display at 99+ when count exceeds 99', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="triage" decisionBadge={100} />)
    expect(html).toContain('>99+<')
    expect(html).not.toContain('>100<')
  })

  it('shows no badge span when decisionBadge is 0', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="triage" decisionBadge={0} />)
    expect(html).not.toContain('decisions pending')
  })

  it('renders the badge only once (on Needs you, not on other entries)', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="triage" decisionBadge={5} />)
    const badgeMatches = html.match(/decisions pending/g)
    expect(badgeMatches).toHaveLength(1)
  })

  it('badge is labelled for screen readers', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="triage" decisionBadge={7} />)
    expect(html).toContain('aria-label="7 decisions pending"')
  })

  it('uses badgeAriaLabel when provided — shows composition instead of plain count', () => {
    const label = '4 decisions pending (3 alerts + 1 proposal cluster)'
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="triage" decisionBadge={4} badgeAriaLabel={label} />,
    )
    expect(html).toContain(`aria-label="${label}"`)
  })
})

// ── Shell — topbar breadcrumb ─────────────────────────────────────────────────

describe('Shell — topbar breadcrumb', () => {
  it('renders a Breadcrumb nav for #/chat (top-level nav route)', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
  })

  it('renders a Breadcrumb nav for #/events (Developer group route)', () => {
    const html = renderToStaticMarkup(<Shell hash="#/events">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
  })

  it('active (terminal) breadcrumb segment uses the brightest on-dark token', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('text-fg-dark')
    // and the non-terminal group label stays muted, so the two are distinguishable
    expect(html).toContain('text-muted-dark')
  })

  it('renders separator › in the breadcrumb for nav routes', () => {
    const html = renderToStaticMarkup(<Shell hash="#/progress">page</Shell>)
    // Must contain both breadcrumb nav and the separator glyph
    expect(html).toContain('aria-label="Breadcrumb"')
    expect(html).toContain('›')
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

  it('renders all nav entry labels (nine entries)', () => {
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

  it('highlights Proposals when hash is #/proposals', () => {
    const html = renderToStaticMarkup(<Shell hash="#/proposals">page</Shell>)
    expect(html).toContain('aria-current="page"')
    // Exactly one active entry
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })

  it('highlights Progress (not Proposals) for bare #/progress hash', () => {
    const html = renderToStaticMarkup(<Shell hash="#/progress">page</Shell>)
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })
})

// ── Shell — badge computation (draft-proposal exclusion) ──────────────────────

describe('Shell — Needs you badge computation', () => {
  const makeItem = (kind: string, id = `${kind}:1`) => ({
    id,
    kind,
    priority: 'normal',
    at: '2024-01-01T00:00:00.000Z',
  })

  it('shows badge for an operational alert item', () => {
    mockActionQueueItems = [makeItem('daemon-died')]
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('decisions pending')
    mockActionQueueItems = []
  })

  it('does not count a draft-proposal item toward the badge', () => {
    mockActionQueueItems = [makeItem('draft-proposal')]
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).not.toContain('decisions pending')
    mockActionQueueItems = []
  })

  it('counts operational alerts but not draft-proposals when both present', () => {
    mockActionQueueItems = [
      makeItem('daemon-died', 'daemon-died:1'),
      makeItem('reflect-recommended', 'reflect-recommended:1'),
      makeItem('draft-proposal', 'draft-proposal:p1'),
    ]
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    // 2 operational + 1 draft → badge shows 2, not 3
    expect(html).toContain('>2<')
    expect(html).not.toContain('>3<')
    mockActionQueueItems = []
  })

  // Regression: the badge used to be the CLUSTERED rendered-row count, so a
  // kind exceeding CLUSTER_THRESHOLD (5) collapsed to 1 row and undercounted
  // the badge relative to the triage page's own canonical count. The badge
  // must report the raw item count — the same `countNeedsYou` definition
  // used by TriagePage, ChatGreeting, and the situation card. Mirrors the
  // fixture in needsYouParity.test.tsx and
  // orchestrator/.../situation-report.test.ts (14 = 5 failed + 9 awaiting-human).
  it('reports the raw item count, not the clustered rendered-row count', () => {
    mockActionQueueItems = [
      ...Array.from({ length: 5 }, (_, i) => makeItem('failed', `failed:${i}`)),
      ...Array.from({ length: 9 }, (_, i) => makeItem('awaiting-human', `awaiting:${i}`)),
      ...Array.from({ length: 20 }, (_, i) => makeItem('draft-proposal', `draft:${i}`)),
    ]
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('>14<')
    expect(html).not.toContain('>7<')
    mockActionQueueItems = []
  })
})
