/**
 * Shell component tests.
 *
 * ShellSidebar is tested directly with controlled props (no hooks) to verify:
 *   - active route is highlighted (aria-current, accent fill, active rail)
 *   - "Needs You" badge appears only when decisionBadge > 0
 *   - no badge on any other nav entry
 *   - every destination is visible at rest (nothing behind a disclosure)
 *
 * Shell is tested via renderToStaticMarkup with mocked hooks to verify:
 *   - all group headers are rendered
 *   - nav entry labels are rendered
 *   - wordmark is present
 *   - the SSE reconnecting pill reflects daemon connection state
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

const allEntries = () => SHELL_NAV_GROUPS.flatMap((g) => g.entries)
const groupNamed = (label: string) => SHELL_NAV_GROUPS.find((g) => g.label === label)

// ── SHELL_NAV_GROUPS ──────────────────────────────────────────────────────────

describe('SHELL_NAV_GROUPS', () => {
  it('defines exactly four groups', () => {
    expect(SHELL_NAV_GROUPS).toHaveLength(4)
  })

  it('names the groups Inbox, Activity, Insight, Control in order', () => {
    expect(SHELL_NAV_GROUPS.map((g) => g.label)).toEqual([
      'Inbox',
      'Activity',
      'Insight',
      'Control',
    ])
  })

  it('has ten total nav entries across all groups', () => {
    expect(allEntries()).toHaveLength(10)
  })

  it('Inbox group contains Needs You, Proposals and Chat', () => {
    const labels = groupNamed('Inbox')?.entries.map((e) => e.label)
    expect(labels).toEqual(['Needs You', 'Proposals', 'Chat'])
  })

  it('Needs You is the first entry in the Inbox group', () => {
    expect(SHELL_NAV_GROUPS[0].entries[0].label).toBe('Needs You')
    expect(SHELL_NAV_GROUPS[0].entries[0].href).toBe('#/triage')
  })

  it('Activity group contains Progress and Events', () => {
    const labels = groupNamed('Activity')?.entries.map((e) => e.label)
    expect(labels).toEqual(['Progress', 'Events'])
  })

  it('Insight group contains KPI, Studio, Reflections and Steward', () => {
    const labels = groupNamed('Insight')?.entries.map((e) => e.label)
    expect(labels).toEqual(['KPI', 'Studio', 'Reflections', 'Steward'])
  })

  it('Control is the pinned footer group and holds Control Room', () => {
    const control = groupNamed('Control')
    expect(control?.footer).toBe(true)
    expect(control?.entries.map((e) => e.label)).toEqual(['Control Room'])
  })

  // Regression: the old shape hid Events / Reflections / Steward / Studio behind
  // a collapsible "Advanced" drawer. Nothing is collapsible any more — every
  // destination is reachable in one click from rest.
  it('no group is collapsible — every destination is visible at rest', () => {
    for (const group of SHELL_NAV_GROUPS) {
      expect('collapsible' in group).toBe(false)
    }
  })

  it('Steward has a sidebar entry in the Insight group', () => {
    const steward = groupNamed('Insight')?.entries.find((e) => e.label === 'Steward')
    expect(steward).toBeDefined()
    expect(steward?.href).toBe('#/steward')
    expect(steward?.route).toBe('steward')
  })

  it('Studio has a sidebar entry in the Insight group pointing at #/studio', () => {
    const studio = groupNamed('Insight')?.entries.find((e) => e.label === 'Studio')
    expect(studio).toBeDefined()
    expect(studio?.route).toBe('studio')
    expect(studio?.href).toBe('#/studio')
  })

  // Group subtitles were removed: they doubled each header's height in a
  // ten-item nav and the renamed groups (Inbox / Activity / Insight) already
  // say what they hold.
  it('carries no group descriptions', () => {
    for (const group of SHELL_NAV_GROUPS) {
      expect('description' in group).toBe(false)
    }
  })

  it('all nav entry icons are unique — no duplicate glyphs', () => {
    const icons = allEntries().map((e) => e.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  // Regression: icons used to be Unicode geometric glyphs with no shared stroke
  // weight or optical alignment. They are Lucide components now — the wordmark
  // ◆ is the only geometric mark left, and it is not a nav icon.
  it('every nav icon is a component, not a glyph string', () => {
    for (const entry of allEntries()) {
      expect(typeof entry.icon).not.toBe('string')
    }
  })

  it('Proposals entry href is #/proposals', () => {
    const entry = allEntries().find((e) => e.label === 'Proposals')
    expect(entry?.href).toBe('#/proposals')
  })
})

// ── ShellSidebar — nothing hidden ─────────────────────────────────────────────

describe('ShellSidebar — every destination is reachable at rest', () => {
  it('renders a link for every nav entry with no expansion needed', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    for (const entry of allEntries()) {
      expect(html).toContain(`href="${entry.href}"`)
    }
  })

  it('renders no disclosure toggle', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    expect(html).not.toContain('aria-expanded')
  })

  it('renders every group header', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    for (const group of SHELL_NAV_GROUPS.filter((g) => g.footer !== true)) {
      expect(html).toContain(group.label)
    }
  })
})

// ── ShellSidebar — active state ───────────────────────────────────────────────

describe('ShellSidebar — active state', () => {
  it('marks the active route with aria-current="page"', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    expect(html).toContain('aria-current="page"')
  })

  it('applies exactly one aria-current="page" per route', () => {
    for (const entry of allEntries()) {
      const html = renderToStaticMarkup(
        <ShellSidebar activeRoute={entry.route} decisionBadge={0} />,
      )
      const matches = html.match(/aria-current="page"/g)
      expect(matches).toHaveLength(1)
    }
  })

  it('applies the accent fill to the active entry', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="progress" decisionBadge={0} />)
    expect(html).toContain('bg-accent-on-dark/12')
    expect(html).toContain('text-accent-on-dark')
  })

  it('renders an active rail on the active entry only', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="events" decisionBadge={0} />)
    const rails = html.match(/rounded-r-full bg-accent-on-dark/g)
    expect(rails).toHaveLength(1)
  })

  // Regression: the active entry used to carry an inline
  // style={{ color: 'var(--color-amber)' }} purely to dodge the token lint.
  // That colour is now the semantic --color-accent-on-dark token.
  it('uses no inline colour style', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="chat" decisionBadge={0} />)
    expect(html).not.toContain('var(--color-amber)')
  })

  it('highlights Studio (not Progress) when activeRoute is studio', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="studio" decisionBadge={0} />)
    expect(html).toMatch(/href="#\/studio"[^>]*aria-current="page"/)
  })

  it('highlights Proposals (not Progress) when activeRoute is proposals', () => {
    const html = renderToStaticMarkup(<ShellSidebar activeRoute="proposals" decisionBadge={0} />)
    expect(html).toMatch(/href="#\/proposals"[^>]*aria-current="page"/)
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
})

// ── Shell — topbar breadcrumb ─────────────────────────────────────────────────

describe('Shell — topbar breadcrumb', () => {
  it('renders a Breadcrumb nav for #/chat', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
  })

  it('renders a Breadcrumb nav for #/events', () => {
    const html = renderToStaticMarkup(<Shell hash="#/events">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
  })

  it('breadcrumb for #/triage reads Inbox / Needs You', () => {
    const html = renderToStaticMarkup(<Shell hash="#/triage">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
    expect(html).toContain('Inbox')
    expect(html).toContain('Needs You')
  })

  it('active (terminal) breadcrumb segment uses the brightest on-dark token', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('text-fg-dark')
    // and the non-terminal group label stays muted, so the two are distinguishable
    expect(html).toContain('text-muted-dark')
  })

  it('renders a separator between breadcrumb segments', () => {
    const html = renderToStaticMarkup(<Shell hash="#/progress">page</Shell>)
    expect(html).toContain('aria-label="Breadcrumb"')
    expect(html).toContain('/')
  })
})

// ── Shell — structure ─────────────────────────────────────────────────────────

describe('Shell', () => {
  it('renders all group headers', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    expect(html).toContain('Inbox')
    expect(html).toContain('Activity')
    expect(html).toContain('Insight')
  })

  it('renders every nav entry label', () => {
    const html = renderToStaticMarkup(<Shell hash="#/chat">page</Shell>)
    for (const entry of allEntries()) {
      expect(html).toContain(entry.label)
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
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('bg-accent-on-dark/12')
  })

  it('highlights Studio when hash is #/studio/<id>', () => {
    const html = renderToStaticMarkup(<Shell hash="#/studio/abc123">page</Shell>)
    expect(html).toMatch(/href="#\/studio"[^>]*aria-current="page"/)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('highlights Studio when hash is bare #/studio', () => {
    const html = renderToStaticMarkup(<Shell hash="#/studio">page</Shell>)
    expect(html).toMatch(/href="#\/studio"[^>]*aria-current="page"/)
  })

  it('highlights Steward when hash is #/steward', () => {
    const html = renderToStaticMarkup(<Shell hash="#/steward">page</Shell>)
    expect(html).toMatch(/href="#\/steward"[^>]*aria-current="page"/)
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

// ---------------------------------------------------------------------------
// Reaching the page from the keyboard
//
// Thirteen tab stops stood between a keyboard user and the first control on
// the page — project switcher, parked-task chip, bell, then all ten nav links
// — and the chrome is identical on every route, so the same thirteen were
// re-traversed to reach different content. There was also no <main> at all,
// so "jump to main content" was unavailable to a screen reader by any route.
// ---------------------------------------------------------------------------

describe('Shell — keyboard entry to the page', () => {
  it('offers a skip link before anything else in the tab order', () => {
    const html = renderToStaticMarkup(<Shell hash="#/triage">page</Shell>)
    const skip = html.indexOf('data-testid="skip-link"')
    expect(skip).toBeGreaterThan(-1)
    // Source order is tab order here: nothing focusable may precede it.
    const firstNav = html.indexOf('<a', html.indexOf('<nav'))
    expect(skip).toBeLessThan(firstNav)
  })

  it('wraps the page in a <main> the skip link can target', () => {
    const html = renderToStaticMarkup(<Shell hash="#/triage">page</Shell>)
    expect(html).toContain('<main')
    expect(html).toContain('id="page-content"')
    // tabIndex -1 so it is a programmatic focus target and not a tab stop.
    expect(html).toContain('tabindex="-1"')
  })

  it('reveals the skip link on plain :focus, not on :focus-visible', () => {
    // The link is off-screen at all times and has no pointer surface, so the
    // distinction focus-visible exists to draw cannot arise — and Chromium
    // withholds :focus-visible often enough that relying on it produced a
    // skip link that held focus while sitting 56px above the viewport at
    // opacity 0. Measured as exactly that before the change.
    const html = renderToStaticMarkup(<Shell hash="#/triage">page</Shell>)
    expect(html).toContain('focus:opacity-100')
    expect(html).not.toContain('focus-visible:opacity-100')
  })

  it('stays absolutely positioned so it cannot claim a grid cell', () => {
    // sr-only/not-sr-only toggle `position` in one Tailwind layer. The link is
    // a child of the shell's grid: the moment it went static it would take a
    // cell and push the topbar out of it.
    const html = renderToStaticMarkup(<Shell hash="#/triage">page</Shell>)
    const tag = html.slice(html.indexOf('data-testid="skip-link"'))
    const cls = tag.slice(tag.indexOf('class="'), tag.indexOf('>'))
    expect(cls).toContain('absolute')
    expect(cls).not.toContain('sr-only')
  })
})
