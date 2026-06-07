/**
 * Tests for the ProjectSelector widget.
 *
 * Verifies observable behaviour through the public interface:
 *   - trigger shows the currently focused project (color-coded glyph + name)
 *   - the open dropdown lists all registered projects
 *   - the focused project carries aria-current="true" in the open dropdown
 *   - Start button appears only for 'down' projects in the open dropdown
 *   - renders nothing when the project list is empty
 *
 * Strategy: ProjectSelectorInner accepts all state as props so it can be
 * rendered in open=false (trigger tests) or open=true (dropdown list tests)
 * without a DOM, using renderToStaticMarkup. ProjectSelector itself is tested
 * for the empty-state case via the mocked useFocusedProject hook.
 */

import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const liveProject: Project = {
  projectId: 'proj-live',
  repoRoot: '/repos/live-project',
  name: 'Live Project',
  health: 'live',
}

const degradedProject: Project = {
  projectId: 'proj-degraded',
  repoRoot: '/repos/degraded-project',
  name: 'Degraded Project',
  health: 'degraded',
}

const downProject: Project = {
  projectId: 'proj-down',
  repoRoot: '/repos/down-project',
  name: 'Down Project',
  health: 'down',
}

const allProjects = [liveProject, degradedProject, downProject]

const noop = () => {}
const setFocusedProjectId = mock(() => {})

// ---------------------------------------------------------------------------
// Module mocks — needed for the ProjectSelector (stateful wrapper) tests.
// ProjectSelectorInner tests use props directly and don't require these.
// ---------------------------------------------------------------------------

const mockUseFocusedProject = mock(() => ({
  projects: allProjects,
  focusedProjectId: 'proj-live',
  setFocusedProjectId,
}))

mock.module('@/shared/useFocusedProject', () => ({
  useFocusedProject: mockUseFocusedProject,
  useRefreshProjects: () => async () => {},
}))

mock.module('@/shared/api', () => ({
  startProject: mock(async (_id: string) => {}),
}))

const { ProjectSelector, ProjectSelectorInner } = await import('./ProjectSelector')

// ---------------------------------------------------------------------------
// Helper: render Inner in closed state (trigger visible, list hidden)
// ---------------------------------------------------------------------------
const renderClosed = (focusedProjectId = 'proj-live') =>
  renderToStaticMarkup(
    <ProjectSelectorInner
      projects={allProjects}
      focusedProjectId={focusedProjectId}
      open={false}
      starting={null}
      onToggle={noop}
      onSelect={noop}
      onStart={noop}
    />,
  )

// ---------------------------------------------------------------------------
// Helper: render Inner in open state (trigger + list both visible)
// ---------------------------------------------------------------------------
const renderOpen = (focusedProjectId = 'proj-live', starting: string | null = null) =>
  renderToStaticMarkup(
    <ProjectSelectorInner
      projects={allProjects}
      focusedProjectId={focusedProjectId}
      open={true}
      starting={starting}
      onToggle={noop}
      onSelect={noop}
      onStart={noop}
    />,
  )

// ---------------------------------------------------------------------------
// Trigger — closed state
// ---------------------------------------------------------------------------

describe('ProjectSelector – trigger shows focused project', () => {
  it('renders the trigger button', () => {
    const html = renderClosed()
    expect(html).toContain('data-testid="project-selector-trigger"')
  })

  it('trigger displays the focused project name', () => {
    const html = renderClosed('proj-live')
    expect(html).toContain('Live Project')
  })

  it('trigger displays a different focused project when focusedProjectId changes', () => {
    const html = renderClosed('proj-degraded')
    expect(html).toContain('Degraded Project')
  })

  it('trigger carries aria-haspopup="listbox"', () => {
    const html = renderClosed()
    expect(html).toContain('aria-haspopup="listbox"')
  })

  it('trigger has aria-expanded="false" when closed', () => {
    const html = renderClosed()
    expect(html).toContain('aria-expanded="false"')
  })

  it('trigger has aria-expanded="true" when open', () => {
    const html = renderOpen()
    expect(html).toContain('aria-expanded="true"')
  })

  it('trigger glyph has role="img" so the status is accessible', () => {
    const html = renderClosed('proj-live')
    expect(html).toContain('role="img"')
  })

  it('trigger glyph aria-label carries the live status for a live focused project', () => {
    const html = renderClosed('proj-live')
    expect(html).toContain('aria-label="Live Project — live"')
  })

  it('trigger glyph aria-label carries the down status for a down focused project', () => {
    const html = renderClosed('proj-down')
    expect(html).toContain('aria-label="Down Project — down"')
  })

  it('trigger glyph has the live color class for a live focused project', () => {
    const html = renderClosed('proj-live')
    expect(html).toContain('text-green-400')
  })

  it('trigger glyph has the down color class for a down focused project', () => {
    const html = renderClosed('proj-down')
    expect(html).toContain('text-red-400')
  })

  it('trigger does not render an old text health-badge pill', () => {
    const html = renderClosed('proj-live')
    expect(html).not.toContain('data-testid="health-badge-trigger"')
  })

  it('the dropdown list is NOT present in the closed state', () => {
    const html = renderClosed()
    expect(html).not.toContain('data-testid="project-dropdown"')
  })
})

// ---------------------------------------------------------------------------
// Open dropdown — listing all projects
// ---------------------------------------------------------------------------

describe('ProjectSelector – opening reveals all projects', () => {
  it('renders the dropdown panel when open', () => {
    const html = renderOpen()
    expect(html).toContain('data-testid="project-dropdown"')
  })

  it('shows all project names in the open dropdown', () => {
    const html = renderOpen()
    expect(html).toContain('Live Project')
    expect(html).toContain('Degraded Project')
    expect(html).toContain('Down Project')
  })

  it('renders a listbox role on the dropdown', () => {
    const html = renderOpen()
    expect(html).toContain('role="listbox"')
  })

  it('renders an item for each project', () => {
    const html = renderOpen()
    expect(html).toContain('data-testid="project-item-proj-live"')
    expect(html).toContain('data-testid="project-item-proj-degraded"')
    expect(html).toContain('data-testid="project-item-proj-down"')
  })

  it('dropdown glyphs carry health status in their aria-labels', () => {
    const html = renderOpen()
    expect(html).toContain('aria-label="Live Project — live"')
    expect(html).toContain('aria-label="Degraded Project — degraded"')
    expect(html).toContain('aria-label="Down Project — down"')
  })

  it('live project glyph has green color class', () => {
    const html = renderOpen()
    expect(html).toContain('text-green-400')
  })

  it('degraded project glyph has yellow color class', () => {
    const html = renderOpen()
    expect(html).toContain('text-yellow-400')
  })

  it('down project glyph has red color class', () => {
    const html = renderOpen()
    expect(html).toContain('text-red-400')
  })

  it('does not render old text health-badge pills', () => {
    const html = renderOpen()
    expect(html).not.toContain('data-testid="health-badge-proj-live"')
    expect(html).not.toContain('data-testid="health-badge-proj-degraded"')
    expect(html).not.toContain('data-testid="health-badge-proj-down"')
  })
})

// ---------------------------------------------------------------------------
// Focused project — aria-current in the open dropdown
// ---------------------------------------------------------------------------

describe('ProjectSelector – focused project in dropdown', () => {
  it('marks the focused project item with aria-current="true"', () => {
    const html = renderOpen('proj-live')
    // aria-current="true" is on the focused item element
    expect(html).toContain('data-testid="project-item-proj-live"')
    expect(html).toContain('aria-current="true"')
  })

  it('only one item carries aria-current="true"', () => {
    const html = renderOpen('proj-live')
    const matches = html.match(/aria-current="true"/g)
    expect(matches).toHaveLength(1)
  })

  it('non-focused items do not carry aria-current', () => {
    const html = renderOpen('proj-live')
    // The degraded and down items must not have aria-current
    expect(html).not.toMatch(/data-testid="project-item-proj-degraded"[^/]*aria-current/)
    expect(html).not.toMatch(/aria-current[^/]*data-testid="project-item-proj-degraded"/)
  })

  it('aria-current moves to a different item when focusedProjectId changes', () => {
    const html = renderOpen('proj-degraded')
    expect(html).toContain('aria-current="true"')
    // The degraded item element should contain aria-current
    // Check: aria-current appears and the degraded item appears in the HTML
    expect(html).toContain('data-testid="project-item-proj-degraded"')
    // The live item must NOT have aria-current
    expect(html).not.toMatch(/data-testid="project-item-proj-live"[^/]*aria-current/)
  })
})

// ---------------------------------------------------------------------------
// Start button — only for 'down' projects
// ---------------------------------------------------------------------------

describe('ProjectSelector – Start control in dropdown', () => {
  it('renders a Start button only for the down project', () => {
    const html = renderOpen()
    expect(html).toContain('data-testid="start-btn-proj-down"')
    expect(html).not.toContain('data-testid="start-btn-proj-live"')
    expect(html).not.toContain('data-testid="start-btn-proj-degraded"')
  })

  it('Start button text is "Start" when not starting', () => {
    const html = renderOpen()
    expect(html).toMatch(/data-testid="start-btn-proj-down"[^>]*>Start</)
  })

  it('Start button shows spinner text when that project is starting', () => {
    const html = renderOpen('proj-live', 'proj-down')
    expect(html).toMatch(/data-testid="start-btn-proj-down"[^>]*>…</)
  })

  it('Start button is disabled while starting', () => {
    const html = renderOpen('proj-live', 'proj-down')
    // The disabled attribute should appear near the start-btn
    expect(html).toContain('disabled')
  })
})

// ---------------------------------------------------------------------------
// Empty state — ProjectSelector renders nothing when no projects
// ---------------------------------------------------------------------------

describe('ProjectSelector – empty state', () => {
  it('renders nothing when the project list is empty', () => {
    mockUseFocusedProject.mockReturnValueOnce({
      projects: [],
      focusedProjectId: null,
      setFocusedProjectId,
    })
    const html = renderToStaticMarkup(<ProjectSelector />)
    expect(html).toBe('')
  })
})
