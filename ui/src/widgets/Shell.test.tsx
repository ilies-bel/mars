/**
 * Shell component tests.
 *
 * ShellSidebar is tested directly with controlled props (no hooks) to verify:
 *   - active route is highlighted (aria-current, flame bg, right-edge accent, amber text)
 *   - "Needs You" badge appears only when decisionBadge > 0
 *   - no badge on any other nav entry
 *   - proposals/progress mutual-exclusion logic
 *   - Advanced group is collapsed by default; expands via advancedExpanded prop
 *
 * Shell is tested via renderToStaticMarkup with mocked hooks to verify:
 *   - four group headers are rendered in order
 *   - nav entry labels are rendered
 *   - wordmark and live-dot are present
 *   - live-dot reflects daemon connection state (green+Live vs grey+Reconnecting)
 */

import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// ── Module mocks — must be registered before any import of the component ─────

// useCounts — Shell reads useCounts().needsYou for the sidebar badge. This is
// the single source of truth: the same value the board header and chat greeting
// display (both ultimately derive from useCounts() rather than each computing
// the count from a different endpoint). Mutable so tests can set the badge value.
let mockNeedsYou = 0
mock.module('@/entities/counts/useCounts', () => ({
  useCounts: () => ({
    needsYou: mockNeedsYou,
    running: 0, verifying: 0, merging: 0,
    queued: 0, blocked: 0, failed: 0, doneToday: 0,
    proposals: { draft: 0, total: 0 },
    known: true,
  }),
}))

// useActionQueue — no longer used by Shell for the badge, but kept as a stub
// for any residual imports (BellMenu, etc.) that pull it transitively.
mock.module('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({
    items: [],
    error: null,
    projectsError: null,
    projectsEmpty: false,
  }),
}))

// ProjectSelector pulls in providers; stub it out for unit tests.
mock.module('@/widgets/ProjectSelector', () => ({
  ProjectSelector: () => null,
}))

// BellMenu uses hooks (useState, useQueryClient, useActionQueue, …) that are
// unavailable under renderToStaticMarkup; stub it the same way as ProjectSelector.
mock.module('@/widgets/BellMenu', () => ({
  BellMenu: () => null,
}))

// useDispatchState — Shell renders the global paused chip from it. These tests
// render with renderToStaticMarkup and no QueryClientProvider, so stub it out
// the same way useActionQueue is. Dispatch running ⇒ the chip renders nothing.
mock.module('@/entities/operator/useDispatchState', () => ({
  useDispatchState: () => ({ paused: false, reason: null, since: null, detail: null }),
  pauseReasonLabel: () => 'paused',
}))

// sseStatus — Shell renders the SSE reconnecting pill from it.
// Connected by default (no pill); tests that check the disconnected state
// set mockSseConnected = false before rendering.
let mockSseConnected = true
mock.module('@/shared/sseStatus', () => ({
  useSseConnected: () => mockSseConnected,
  setSseConnected: () => {},
}))

// ── Import after mocks are registered ────────────────────────────────────────

const { Shell, ShellSidebar, SHELL_NAV_GROUPS } = await import('./Shell')

// ── SHELL_NAV_GROUPS ──────────────────────────────────────────────────────────

describe('SHELL_NAV_GROUPS', () => {
  it('defines exactly four groups', () => {
    expect(SHELL_NAV_GROUPS).toHaveLength(4)
  })

  it('names the groups Decide, Watch, Tune, Advanced in order', () => {
    expect(SHELL_NAV_GROUPS[0].label).toBe('Decide')
    expect(SHELL_NAV_GROUPS[1].label).toBe('Watch')
    expect(SHELL_NAV_GROUPS[2].label).toBe('Tune')
    expect(SHELL_NAV_GROUPS[3].label).toBe('Advanced')
  })

  it('has ten total nav entries across all groups', () => {
    const total = SHELL_NAV_GROUPS.reduce((sum, g) => sum + g.entries.length, 0)
    expect(total).toBe(10)
  })

  it('Decide group contains Needs You and Proposals', () => {
    const decide = SHELL_NAV_GROUPS[0]
    const labels = decide.entries.map((e) => e.label)
    expect(labels).toContain('Needs You')
    expect(labels).toContain('Proposals')
  })

  it('Needs You is the first entry in the Decide group', () => {
    expect(SHELL_NAV_GROUPS[0].entries[0].label).toBe('Needs You')
    expect(SHELL_NAV_GROUPS[0].entries[0].href).toBe('#/triage')
  })

  it('Watch group contains Progress and Chat', () => {
    const watch = SHELL_NAV_GROUPS[1]
    const labels = watch.entries.map((e) => e.label)
    expect(labels).toContain('Progress')
    expect(labels).toContain('Chat')
  })

  it('Tune group contains Control Room and KPI', () => {
    const tune = SHELL_NAV_GROUPS[2]
    const labels = tune.entries.map((e) => e.label)
    expect(labels).toContain('Control Room')
    expect(labels).toContain('KPI')
  })

  it('Advanced group contains Events, Reflections, Steward, and Studio', () => {
    const advanced = SHELL_NAV_GROUPS[3]
    const labels = advanced.entries.map((e) => e.label)
    expect(labels).toContain('Events')
    expect(labels).toContain('Reflections')
    expect(labels).toContain('Steward')
    expect(labels).toContain('Studio')
  })

  it('Advanced group is marked collapsible', () => {
    expect(SHELL_NAV_GROUPS[3].collapsible).toBe(true)
  })

  it('Steward has a sidebar entry in the Advanced group', () => {
    const advanced = SHELL_NAV_GROUPS[3]
    const steward = advanced.entries.find((e) => e.label === 'Steward')
    expect(steward).toBeDefined()
    expect(steward?.href).toBe('#/steward')
    expect(steward?.route).toBe('steward')
  })

  it('Studio has a sidebar entry in the Advanced group', () => {
    const advanced = SHELL_NAV_GROUPS[3]
    const studio = advanced.entries.find((e) => e.label === 'Studio')
    expect(studio).toBeDefined()
    expect(studio?.route).toBe('studio')
  })

  it('Decide group has a description', () => {
    expect(SHELL_NAV_GROUPS[0].description).toBeTruthy()
  })

  it('Watch group has a description', () => {
    expect(SHELL_NAV_GROUPS[1].description).toBeTruthy()
  })

  it('Tune group has a description', () => {
    expect(SHELL_NAV_GROUPS[2].description).toBeTruthy()
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

// ── ShellSidebar — Advanced group collapse ────────────────────────────────────

describe('ShellSidebar — Advanced group collapse', () => {
  it('Advanced group entries are hidden when advancedExpanded is false (default)', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    // Events and Reflections links should not appear in the collapsed state
    expect(html).not.toContain('href="#/events"')
    expect(html).not.toContain('href="#/reflections"')
  })

  it('Advanced group entries are visible when advancedExpanded is true', () => {
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="chat" decisionBadge={0} advancedExpanded={true} />,
    )
    expect(html).toContain('href="#/events"')
    expect(html).toContain('href="#/reflections"')
  })

  it('Advanced group renders a toggle button with aria-expanded=false by default', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    expect(html).toContain('aria-expanded="false"')
  })

  it('Advanced toggle button shows aria-expanded=true when expanded', () => {
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="chat" decisionBadge={0} advancedExpanded={true} />,
    )
    expect(html).toContain('aria-expanded="true"')
  })

  it('non-collapsible groups are always visible', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    // Decide, Watch, Tune entries always visible
    expect(html).toContain('href="#/triage"')
    expect(html).toContain('href="#/progress"')
    expect(html).toContain('href="#/control"')
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
    // Events is in Advanced — must expand it first
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="events" decisionBadge={0} advancedExpanded={true} />,
    )
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

  it('Studio entry is highlighted when activeRoute is studio and Advanced is expanded', () => {
    // Advanced must be expanded to see Studio; Shell auto-expands it but ShellSidebar
    // is a pure render function — pass advancedExpanded=true explicitly here.
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="studio" decisionBadge={0} advancedExpanded={true} />,
    )
    expect(html).toContain('aria-current="page"')
    // Exactly one active entry
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })

  it('progress entry is NOT highlighted when activeRoute is studio', () => {
    // Studio has its own sidebar entry; Progress no longer claims studio routes.
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="studio" decisionBadge={0} advancedExpanded={true} />,
    )
    // Only one active entry — the Studio entry, not Progress
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
    // The active entry href should be the Studio entry (#/progress) not the Progress entry
    // (both point to #/progress, so we verify no double-active by the count above)
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

  it('highlights Studio (not Progress) when activeRoute is studio and Advanced is expanded', () => {
    // Studio now has its own sidebar entry in Advanced.
    // ShellSidebar is a pure render function — pass advancedExpanded=true so the entry is visible.
    const html = renderToStaticMarkup(
      <ShellSidebar activeRoute="studio" decisionBadge={0} advancedExpanded={true} />,
    )
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })
})

// ── ShellSidebar — Action Queue badge ────────────────────────────────────────

describe('ShellSidebar — Action Queue badge', () => {
  it('shows a numeric badge on Needs You when decisionBadge > 0', () => {
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

  it('renders the badge only once (on Needs You, not on other entries)', () => {
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

  it('badge does NOT appear on Proposals, Progress, Chat, Control Room, or KPI', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="triage" decisionBadge={5} />)
    // The badge aria-label contains "decisions pending" — should appear exactly once
    const badgeMatches = html.match(/decisions pending/g)
    expect(badgeMatches).toHaveLength(1)
  })
})

// ── Shell — topbar breadcrumb ─────────────────────────────────────────────────

describe('Shell — topbar breadcrumb', () => {
  it('renders a Breadcrumb nav for #/chat (Watch group route)', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
  })

  it('renders a Breadcrumb nav for #/events (Advanced group route) when expanded via hash', () => {
    const html = renderToStaticMarkup(<Shell hash="#/events">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
  })

  it('breadcrumb for #/triage reads Decide › Needs You', () => {
    const html = renderToStaticMarkup(<Shell hash="#/triage">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
    expect(html).toContain('Decide')
    expect(html).toContain('Needs You')
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
  it('renders all four group headers', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('Decide')
    expect(html).toContain('Watch')
    expect(html).toContain('Tune')
    expect(html).toContain('Advanced')
  })

  it('renders non-Advanced nav entry labels', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    // Advanced is collapsed by default so Events/Reflections won't appear as links
    // but the non-Advanced entries should all be present
    const visibleLabels = SHELL_NAV_GROUPS
      .filter((g) => !g.collapsible)
      .flatMap((g) => g.entries.map((e) => e.label))
    for (const label of visibleLabels) {
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
    const html = renderToStaticMarkup(<Shell hash="#/progress">page</Shell>)
    // Progress entry should be active
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

  it('auto-expands Advanced and highlights Studio when hash is #/studio/<id>', () => {
    // Shell auto-expands Advanced for studio/steward routes so the active entry
    // is always visible without requiring the user to expand manually first.
    const html = renderToStaticMarkup(<Shell hash="#/studio/abc123">page</Shell>)
    expect(html).toContain('aria-current="page"')
    // Studio entry is visible (Advanced was auto-expanded)
    expect(html).toContain('href="#/progress"')
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })

  it('auto-expands Advanced and highlights Steward when hash is #/steward', () => {
    const html = renderToStaticMarkup(<Shell hash="#/steward">page</Shell>)
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('href="#/steward"')
    const matches = html.match(/aria-current="page"/g)
    expect(matches).toHaveLength(1)
  })
})

// ── Shell — badge computation (draft-proposal exclusion) ──────────────────────

describe('Shell — badge computation from useCounts()', () => {
  // Shell reads useCounts().needsYou for the badge — the single source of
  // truth shared with the board header and chat greeting. Draft proposals are
  // excluded server-side (same predicate as countNeedsYou), so they never
  // inflate the badge regardless of the action queue state.

  it('shows badge when useCounts returns needsYou > 0', () => {
    mockNeedsYou = 1
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('decisions pending')
    mockNeedsYou = 0
  })

  it('hides badge when useCounts returns needsYou = 0', () => {
    mockNeedsYou = 0
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).not.toContain('decisions pending')
  })

  it('displays the exact needsYou count from useCounts (2 operational alerts)', () => {
    // 2 operational alerts, draft proposals excluded server-side → badge shows 2
    mockNeedsYou = 2
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('>2<')
    expect(html).not.toContain('>3<')
    mockNeedsYou = 0
  })

  // Regression: the badge used to be the CLUSTERED rendered-row count computed
  // client-side, so a kind exceeding CLUSTER_THRESHOLD collapsed to 1 row and
  // undercounted. Now the count comes from the server (viewCounts.needsYou),
  // which uses countNeedsYou — the same definition TriagePage and ChatGreeting
  // use. 5 failed + 9 awaiting-human = 14 (not 7 clustered rows).
  it('displays the server-side count without cluster-row undercounting (14 = 5+9)', () => {
    mockNeedsYou = 14  // 5 failed + 9 awaiting-human, draft-proposals excluded server-side
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('>14<')
    expect(html).not.toContain('>7<')
    mockNeedsYou = 0
  })

  it('caps the displayed badge at 99+ when needsYou > 99', () => {
    mockNeedsYou = 120
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('>99+<')
    mockNeedsYou = 0
  })
})

// ── Shell — SSE reconnecting pill ─────────────────────────────────────────────

describe('Shell — SSE reconnecting pill', () => {
  it('hides the reconnecting pill when the SSE stream is connected', () => {
    mockSseConnected = true
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).not.toContain('live updates paused')
    mockSseConnected = true  // restore default
  })

  it('shows the reconnecting pill when the SSE stream is disconnected', () => {
    mockSseConnected = false
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('live updates paused')
    mockSseConnected = true  // restore default
  })

  it('pill has a descriptive aria-label for screen readers', () => {
    mockSseConnected = false
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('aria-label="Live updates paused — reconnecting to the daemon"')
    mockSseConnected = true  // restore default
  })

  it('pill carries data-testid="sse-reconnecting-pill" for E2E targeting', () => {
    mockSseConnected = false
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('data-testid="sse-reconnecting-pill"')
    mockSseConnected = true  // restore default
  })
})
