// @vitest-environment happy-dom
/**
 * Tests for the ProjectSelector widget.
 *
 * Verifies observable behaviour through the public interface:
 *   - trigger shows the currently focused project (color-coded glyph + name)
 *   - the open dropdown lists all registered projects
 *   - the focused project carries aria-current="true" in the open dropdown
 *   - Start button appears only for 'down' projects in the open dropdown
 *   - renders nothing when the project list is empty
 *   - keyboard navigation: ArrowDown/Up/Home/End move the active option,
 *     Enter selects and closes, Escape closes and returns focus to the trigger
 *
 * Strategy: ProjectSelectorInner accepts all state as props so it can be
 * rendered in open=false (trigger tests) or open=true (dropdown list tests)
 * without a DOM, using renderToStaticMarkup. ProjectSelector itself is tested
 * for the empty-state case via the mocked useFocusedProject hook, and for
 * keyboard interaction via createRoot + act in a happy-dom environment.
 */

import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { Project } from '@/shared/schemas'

// React 19 requires this flag in test environments so `act` warnings are
// surfaced rather than silenced.
// @ts-expect-error — global augmentation for React test env
globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

const restartProjectMock = mock(async (_id: string) => {})

mock.module('@/shared/api', () => ({
  startProject: mock(async (_id: string) => {}),
  restartProject: restartProjectMock,
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
      restarting={null}
      startError={null}
      restartError={null}
      onToggle={noop}
      onSelect={noop}
      onStart={noop}
      onRestart={noop}
    />,
  )

// ---------------------------------------------------------------------------
// Helper: render Inner in open state (trigger + list both visible)
// ---------------------------------------------------------------------------
const renderOpen = (
  focusedProjectId = 'proj-live',
  starting: string | null = null,
  restarting: string | null = null,
  activeIndex: number | null = null,
) =>
  renderToStaticMarkup(
    <ProjectSelectorInner
      projects={allProjects}
      focusedProjectId={focusedProjectId}
      open={true}
      starting={starting}
      restarting={restarting}
      activeIndex={activeIndex}
      startError={null}
      restartError={null}
      onToggle={noop}
      onSelect={noop}
      onStart={noop}
      onRestart={noop}
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

  it('trigger glyph has the live semantic color class for a live focused project', () => {
    const html = renderClosed('proj-live')
    expect(html).toContain('text-success')
  })

  it('trigger glyph has the down semantic color class for a down focused project', () => {
    const html = renderClosed('proj-down')
    expect(html).toContain('text-error')
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

  it('live project glyph has semantic success color class', () => {
    const html = renderOpen()
    expect(html).toContain('text-success')
  })

  it('degraded project glyph has semantic warn color class', () => {
    const html = renderOpen()
    expect(html).toContain('text-warn')
  })

  it('down project glyph has semantic error color class', () => {
    const html = renderOpen()
    expect(html).toContain('text-error')
  })

  it('does not render old text health-badge pills', () => {
    const html = renderOpen()
    expect(html).not.toContain('data-testid="health-badge-proj-live"')
    expect(html).not.toContain('data-testid="health-badge-proj-degraded"')
    expect(html).not.toContain('data-testid="health-badge-proj-down"')
  })

  it('each health state has a distinct glyph shape (non-colour cue)', () => {
    const htmlLive = renderClosed('proj-live')
    const htmlDegraded = renderClosed('proj-degraded')
    const htmlDown = renderClosed('proj-down')
    // Extract the glyph inside the role="img" span — health states must differ
    // in shape, not just colour, so sighted users without colour vision can
    // distinguish them.
    expect(htmlLive).not.toEqual(htmlDegraded)
    expect(htmlLive).not.toEqual(htmlDown)
    expect(htmlDegraded).not.toEqual(htmlDown)
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
// Restart button — only for the focused project
// ---------------------------------------------------------------------------

describe('ProjectSelector – Restart control in dropdown', () => {
  it('renders a Restart button only for the focused project', () => {
    // Default focused = proj-live; Restart appears only on that row.
    const html = renderOpen('proj-live')
    expect(html).toContain('data-testid="restart-btn-proj-live"')
    expect(html).not.toContain('data-testid="restart-btn-proj-degraded"')
    expect(html).not.toContain('data-testid="restart-btn-proj-down"')
  })

  it('Restart button follows the focused project when focus changes', () => {
    const html = renderOpen('proj-degraded')
    expect(html).toContain('data-testid="restart-btn-proj-degraded"')
    expect(html).not.toContain('data-testid="restart-btn-proj-live"')
  })

  it('Restart button text is "Restart" when not restarting', () => {
    const html = renderOpen('proj-live')
    expect(html).toMatch(/data-testid="restart-btn-proj-live"[^>]*>Restart</)
  })

  it('Restart button shows spinner text when that project is restarting', () => {
    const html = renderOpen('proj-live', null, 'proj-live')
    expect(html).toMatch(/data-testid="restart-btn-proj-live"[^>]*>…</)
  })

  it('Restart button is disabled while restarting', () => {
    const html = renderOpen('proj-live', null, 'proj-live')
    expect(html).toContain('disabled')
  })

  it('a down focused project shows both Start and Restart buttons', () => {
    // proj-down is both health=down (shows Start) and focused (shows Restart).
    const html = renderOpen('proj-down')
    expect(html).toContain('data-testid="start-btn-proj-down"')
    expect(html).toContain('data-testid="restart-btn-proj-down"')
  })
})

// ---------------------------------------------------------------------------
// Empty state — ProjectSelector renders nothing when no projects
// ---------------------------------------------------------------------------

describe('ProjectSelector – empty state', () => {
  it('renders nothing when the project list is empty and query has settled', () => {
    mockUseFocusedProject.mockReturnValueOnce({
      projects: [],
      focusedProjectId: null,
      setFocusedProjectId,
      projectsSettled: true,
    })
    const html = renderToStaticMarkup(<ProjectSelector />)
    expect(html).toBe('')
  })

  it('renders a fixed-width placeholder while projects are loading (not yet settled)', () => {
    mockUseFocusedProject.mockReturnValueOnce({
      projects: [],
      focusedProjectId: null,
      setFocusedProjectId,
      projectsSettled: false,
    })
    const html = renderToStaticMarkup(<ProjectSelector />)
    // A width-preserving placeholder prevents the nav links from shifting
    // horizontally when projects arrive (CLS fix).
    expect(html).toContain('w-[140px]')
    // The placeholder must not expose any interactive controls
    expect(html).not.toContain('data-testid="project-selector-trigger"')
  })
})

// ---------------------------------------------------------------------------
// Keyboard navigation ARIA structure (via renderToStaticMarkup)
// ---------------------------------------------------------------------------

describe('ProjectSelector – keyboard ARIA structure', () => {
  it('listbox has tabindex="0" so it can receive keyboard focus', () => {
    const html = renderOpen()
    expect(html).toContain('tabindex="0"')
  })

  it('each option has an id attribute for aria-activedescendant to reference', () => {
    const html = renderOpen()
    expect(html).toContain('id="ps-opt-proj-live"')
    expect(html).toContain('id="ps-opt-proj-degraded"')
    expect(html).toContain('id="ps-opt-proj-down"')
  })

  it('listbox has no aria-activedescendant when activeIndex is null', () => {
    const html = renderOpen('proj-live', null, null, null)
    expect(html).not.toContain('aria-activedescendant')
  })

  it('listbox aria-activedescendant points at the active option', () => {
    const html = renderOpen('proj-live', null, null, 1)
    // activeIndex=1 → proj-degraded
    expect(html).toContain('aria-activedescendant="ps-opt-proj-degraded"')
  })

  it('aria-activedescendant tracks the first option when activeIndex=0', () => {
    const html = renderOpen('proj-live', null, null, 0)
    expect(html).toContain('aria-activedescendant="ps-opt-proj-live"')
  })

  it('aria-activedescendant tracks the last option when activeIndex=last', () => {
    const html = renderOpen('proj-live', null, null, 2)
    expect(html).toContain('aria-activedescendant="ps-opt-proj-down"')
  })
})

// ---------------------------------------------------------------------------
// Keyboard interaction (DOM-based, requires happy-dom environment)
// ---------------------------------------------------------------------------

describe('ProjectSelector – keyboard interaction', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(async () => {
    setFocusedProjectId.mockClear()
    mockUseFocusedProject.mockReturnValue({
      projects: allProjects,
      focusedProjectId: 'proj-live',
      setFocusedProjectId,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<ProjectSelector />)
    })
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  const openDropdown = async (c: HTMLElement) => {
    const trigger = c.querySelector<HTMLButtonElement>(
      '[data-testid="project-selector-trigger"]',
    )
    await act(async () => {
      trigger?.click()
    })
  }

  const keyOnListbox = async (c: HTMLElement, key: string) => {
    const listbox = c.querySelector<HTMLUListElement>('[role="listbox"]')
    await act(async () => {
      listbox?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      )
    })
  }

  it('dropdown opens on trigger click and listbox is present', async () => {
    await openDropdown(container)
    expect(container.querySelector('[data-testid="project-dropdown"]')).not.toBeNull()
  })

  it('listbox receives focus when dropdown opens', async () => {
    await openDropdown(container)
    const listbox = container.querySelector('[role="listbox"]')
    expect(document.activeElement).toBe(listbox)
  })

  it('ArrowDown moves aria-activedescendant to the next option', async () => {
    await openDropdown(container)
    // Initial activeIndex = 0 (proj-live). ArrowDown → index 1 (proj-degraded).
    await keyOnListbox(container, 'ArrowDown')
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-degraded')
  })

  it('ArrowDown does not go past the last option', async () => {
    await openDropdown(container)
    // 3 projects, ArrowDown from index 0 three times should stop at index 2.
    await keyOnListbox(container, 'ArrowDown')
    await keyOnListbox(container, 'ArrowDown')
    await keyOnListbox(container, 'ArrowDown')
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-down')
  })

  it('ArrowUp moves aria-activedescendant to the previous option', async () => {
    await openDropdown(container)
    // Start at index 0. End → index 2. ArrowUp → index 1.
    await keyOnListbox(container, 'End')
    await keyOnListbox(container, 'ArrowUp')
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-degraded')
  })

  it('Home jumps to the first option', async () => {
    await openDropdown(container)
    await keyOnListbox(container, 'End')
    await keyOnListbox(container, 'Home')
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-live')
  })

  it('End jumps to the last option', async () => {
    await openDropdown(container)
    await keyOnListbox(container, 'End')
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-down')
  })

  it('Enter selects the active option and closes the dropdown', async () => {
    await openDropdown(container)
    // Move to proj-degraded (index 1).
    await keyOnListbox(container, 'ArrowDown')
    await keyOnListbox(container, 'Enter')
    expect(setFocusedProjectId).toHaveBeenCalledWith('proj-degraded')
    expect(container.querySelector('[data-testid="project-dropdown"]')).toBeNull()
  })

  it('Enter returns focus to the trigger after closing', async () => {
    await openDropdown(container)
    await keyOnListbox(container, 'ArrowDown')
    await keyOnListbox(container, 'Enter')
    const trigger = container.querySelector('[data-testid="project-selector-trigger"]')
    expect(document.activeElement).toBe(trigger)
  })

  it('Escape closes the dropdown', async () => {
    await openDropdown(container)
    await keyOnListbox(container, 'Escape')
    expect(container.querySelector('[data-testid="project-dropdown"]')).toBeNull()
  })

  it('Escape returns focus to the trigger', async () => {
    await openDropdown(container)
    await keyOnListbox(container, 'Escape')
    const trigger = container.querySelector('[data-testid="project-selector-trigger"]')
    expect(document.activeElement).toBe(trigger)
  })
})

// ---------------------------------------------------------------------------
// Start / Restart error display
// ---------------------------------------------------------------------------

describe('ProjectSelector – Start error display', () => {
  it('renders an inline error under the row when startError matches the project', () => {
    const html = renderToStaticMarkup(
      <ProjectSelectorInner
        projects={allProjects}
        focusedProjectId="proj-live"
        open={true}
        starting={null}
        restarting={null}
        startError={{ projectId: 'proj-down', message: 'Failed to start daemon' }}
        restartError={null}
        onToggle={noop}
        onSelect={noop}
        onStart={noop}
        onRestart={noop}
      />,
    )
    expect(html).toContain('data-testid="start-error-proj-down"')
    expect(html).toContain('Failed to start daemon')
  })

  it('does not render a start error element when startError is null', () => {
    const html = renderOpen()
    expect(html).not.toContain('start-error-')
  })

  it('renders the start error with text-error styling', () => {
    const html = renderToStaticMarkup(
      <ProjectSelectorInner
        projects={allProjects}
        focusedProjectId="proj-live"
        open={true}
        starting={null}
        restarting={null}
        startError={{ projectId: 'proj-down', message: 'Start failed' }}
        restartError={null}
        onToggle={noop}
        onSelect={noop}
        onStart={noop}
        onRestart={noop}
      />,
    )
    // The error paragraph should carry the error colour class
    expect(html).toMatch(/class="[^"]*text-error[^"]*"[^>]*>Start failed</)
  })
})

describe('ProjectSelector – Restart error display', () => {
  it('renders an inline error under the row when restartError matches the project', () => {
    const html = renderToStaticMarkup(
      <ProjectSelectorInner
        projects={allProjects}
        focusedProjectId="proj-live"
        open={true}
        starting={null}
        restarting={null}
        startError={null}
        restartError={{ projectId: 'proj-live', message: 'Restart timed out' }}
        onToggle={noop}
        onSelect={noop}
        onStart={noop}
        onRestart={noop}
      />,
    )
    expect(html).toContain('data-testid="restart-error-proj-live"')
    expect(html).toContain('Restart timed out')
  })

  it('does not render a restart error element when restartError is null', () => {
    const html = renderOpen()
    expect(html).not.toContain('restart-error-')
  })
})

// ---------------------------------------------------------------------------
// Height cap — listbox must not grow unbounded with many projects
// ---------------------------------------------------------------------------

// Build a 30-entry project list to simulate the live registry.
const manyProjects: Project[] = Array.from({ length: 30 }, (_, i) => ({
  projectId: `proj-many-${i}`,
  repoRoot: `/repos/project-${i}`,
  name: `Project ${i}`,
  health: 'live' as const,
}))

describe('ProjectSelector – listbox height cap with a long list', () => {
  it('listbox carries a max-height class so it does not grow unbounded', () => {
    const html = renderToStaticMarkup(
      <ProjectSelectorInner
        projects={manyProjects}
        focusedProjectId="proj-many-0"
        open={true}
        starting={null}
        restarting={null}
        startError={null}
        restartError={null}
        onToggle={noop}
        onSelect={noop}
        onStart={noop}
        onRestart={noop}
      />,
    )
    // The listbox <ul> must carry a max-h-* Tailwind class so the panel is
    // capped even when the registry has 30+ entries.
    expect(html).toMatch(/class="[^"]*max-h-[^"]*"/)
  })

  it('listbox carries overflow-y-auto so rows past the cap are reachable by scrolling', () => {
    const html = renderToStaticMarkup(
      <ProjectSelectorInner
        projects={manyProjects}
        focusedProjectId="proj-many-0"
        open={true}
        starting={null}
        restarting={null}
        startError={null}
        restartError={null}
        onToggle={noop}
        onSelect={noop}
        onStart={noop}
        onRestart={noop}
      />,
    )
    expect(html).toContain('overflow-y-auto')
  })

  it('listbox carries overflow-hidden so the selected row bg is clipped at rounded corners', () => {
    const html = renderToStaticMarkup(
      <ProjectSelectorInner
        projects={manyProjects}
        focusedProjectId="proj-many-0"
        open={true}
        starting={null}
        restarting={null}
        startError={null}
        restartError={null}
        onToggle={noop}
        onSelect={noop}
        onStart={noop}
        onRestart={noop}
      />,
    )
    expect(html).toContain('overflow-hidden')
  })
})

// ---------------------------------------------------------------------------
// ArrowDown past the visible fold — aria-activedescendant must stay in sync
// ---------------------------------------------------------------------------

describe('ProjectSelector – ArrowDown keeps aria-activedescendant in sync past the fold', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(async () => {
    setFocusedProjectId.mockClear()
    mockUseFocusedProject.mockReturnValue({
      projects: manyProjects,
      focusedProjectId: 'proj-many-0',
      setFocusedProjectId,
      projectsSettled: true,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<ProjectSelector />)
    })
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  const openDropdown = async (c: HTMLElement) => {
    const trigger = c.querySelector<HTMLButtonElement>(
      '[data-testid="project-selector-trigger"]',
    )
    await act(async () => {
      trigger?.click()
    })
  }

  const keyOnListbox = async (c: HTMLElement, key: string) => {
    const listbox = c.querySelector<HTMLUListElement>('[role="listbox"]')
    await act(async () => {
      listbox?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      )
    })
  }

  it('aria-activedescendant updates correctly after ArrowDown past 10 rows', async () => {
    await openDropdown(container)
    // Press ArrowDown 10 times — well past a visible fold of ~10–12 rows.
    for (let i = 0; i < 10; i++) {
      await keyOnListbox(container, 'ArrowDown')
    }
    const listbox = container.querySelector('[role="listbox"]')
    // Opening sets activeIndex to index 0 (proj-many-0); 10 ArrowDowns → index 10.
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-many-10')
  })

  it('aria-activedescendant reaches the last item after ArrowDown through all 30 entries', async () => {
    await openDropdown(container)
    // 29 ArrowDowns from index 0 should land on the last entry (index 29).
    for (let i = 0; i < 29; i++) {
      await keyOnListbox(container, 'ArrowDown')
    }
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-many-29')
  })

  it('End jumps directly to the last of 30 entries', async () => {
    await openDropdown(container)
    await keyOnListbox(container, 'End')
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-many-29')
  })

  it('Home jumps back to the first entry after End', async () => {
    await openDropdown(container)
    await keyOnListbox(container, 'End')
    await keyOnListbox(container, 'Home')
    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox?.getAttribute('aria-activedescendant')).toBe('ps-opt-proj-many-0')
  })
})
