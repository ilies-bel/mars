/**
 * Tests for the ProjectSelector widget.
 *
 * Verifies observable behaviour:
 *   - renders project names
 *   - renders health badges (live / degraded / down)
 *   - shows a Start button only for 'down' projects
 *   - marks the focused project with aria-current
 *   - renders nothing when the project list is empty
 *
 * The useFocusedProject hook and startProject / useRefreshProjects are mocked
 * at the module boundary so no QueryClient or server is required.
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

const setFocusedProjectId = mock(() => {})

// ---------------------------------------------------------------------------
// Module mocks — vi.mock calls are hoisted; use a mock fn so per-test
// overrides work via mockReturnValueOnce / mockImplementation.
// ---------------------------------------------------------------------------

const mockUseFocusedProject = mock(() => ({
  projects: [liveProject, degradedProject, downProject],
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

const { ProjectSelector } = await import('./ProjectSelector')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectSelector – project list rendering', () => {
  it('renders a button for each project', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    expect(html).toContain('Live Project')
    expect(html).toContain('Degraded Project')
    expect(html).toContain('Down Project')
  })

  it('renders a health badge for each project', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    expect(html).toContain('data-testid="health-badge-proj-live"')
    expect(html).toContain('data-testid="health-badge-proj-degraded"')
    expect(html).toContain('data-testid="health-badge-proj-down"')
  })

  it('shows "live" badge text for a live project', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    const liveMatch = html.match(/data-testid="health-badge-proj-live"[^>]*>([^<]+)</)
    expect(liveMatch?.[1]).toBe('live')
  })

  it('shows "degraded" badge text for a degraded project', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    const degradedMatch = html.match(/data-testid="health-badge-proj-degraded"[^>]*>([^<]+)</)
    expect(degradedMatch?.[1]).toBe('degraded')
  })

  it('shows "down" badge text for a down project', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    const downMatch = html.match(/data-testid="health-badge-proj-down"[^>]*>([^<]+)</)
    expect(downMatch?.[1]).toBe('down')
  })
})

describe('ProjectSelector – Start control', () => {
  it('renders a Start button only for the down project', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    expect(html).toContain('data-testid="start-btn-proj-down"')
    expect(html).not.toContain('data-testid="start-btn-proj-live"')
    expect(html).not.toContain('data-testid="start-btn-proj-degraded"')
  })

  it('Start button text is "Start"', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    expect(html).toMatch(/data-testid="start-btn-proj-down"[^>]*>Start</)
  })
})

describe('ProjectSelector – focused project', () => {
  it('marks the focused project button with aria-current', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    // aria-current="true" appears somewhere on the focused project item element.
    // Check data-testid and aria-current are both present (order is implementation detail).
    expect(html).toContain('data-testid="project-item-proj-live"')
    expect(html).toContain('aria-current="true"')
    // The non-focused items must NOT carry aria-current.
    expect(html).not.toMatch(/data-testid="project-item-proj-degraded"[^/]*aria-current/)
    expect(html).not.toMatch(/aria-current[^/]*data-testid="project-item-proj-degraded"/)
  })

  it('does not mark non-focused projects with aria-current', () => {
    const html = renderToStaticMarkup(<ProjectSelector />)
    // One occurrence of aria-current="true" total (the focused one only).
    const matches = html.match(/aria-current="true"/g)
    expect(matches).toHaveLength(1)
  })
})

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
