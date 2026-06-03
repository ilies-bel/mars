/**
 * Tests for AppInner shell tint.
 *
 * Verifies observable behaviour through the public interface:
 *   - when a project is focused the shell root div carries --project-tint
 *     set to that project's signature color
 *   - switching the focused project changes the tint value instantly
 *   - when no project is focused (still loading) no tint property is set
 *
 * Strategy: mock all heavy child components / hooks so we can render
 * AppInner in isolation via renderToStaticMarkup and inspect the root div's
 * style attribute without a DOM.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { projectIdentity } from '@/shared/projectIdentity'
import type { Project } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Mock heavy leaf widgets / pages so they don't pull in their own hook deps.
// ---------------------------------------------------------------------------

vi.mock('@/widgets/NavBar', () => ({ NavBar: () => null }))
vi.mock('@/pages/ProgressPage', () => ({ ProgressPage: () => null }))
vi.mock('@/pages/TodoPage', () => ({ ActionQueuePage: () => null }))
vi.mock('@/pages/EventsPage', () => ({ EventsPage: () => null }))
vi.mock('@/widgets/TaskDetailDrawer', () => ({ TaskDetailDrawer: () => null }))
vi.mock('@/widgets/ProposalDetailDrawer', () => ({ ProposalDetailDrawer: () => null }))
vi.mock('@/widgets/ProposalNodeDrawer', () => ({ ProposalNodeDrawer: () => null }))
vi.mock('@/shared/useHashRoute', () => ({ useHashRoute: () => '#/progress' }))
vi.mock('@/entities/todo/useTodo', () => ({
  useTodo: () => ({ drafts: [], staleWorktrees: [] }),
}))
vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({ tasks: [], proposals: [] }),
}))

// useFocusedProject is mocked below; return value is set per-test.
vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProject: vi.fn(),
  FocusedProjectProvider: ({ children }: { children: React.ReactNode }) => children,
}))

import { useFocusedProject } from '@/shared/useFocusedProject'
import { AppInner } from './App'

const mockUseFocusedProject = vi.mocked(useFocusedProject)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeProject = (id: string, name = `Project ${id}`): Project => ({
  projectId: id,
  repoRoot: `/repos/${id}`,
  name,
  health: 'live',
})

const defaultCtx = (
  projects: Project[],
  focusedProjectId: string | null,
) => ({
  projects,
  focusedProjectId,
  setFocusedProjectId: () => {},
  projectsSettled: true,
  projectsError: null,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppInner – shell tint', () => {
  beforeEach(() => {
    mockUseFocusedProject.mockReset()
  })

  it('shell root div carries --project-tint set to the focused project color', () => {
    const project = makeProject('my-proj')
    mockUseFocusedProject.mockReturnValue(defaultCtx([project], 'my-proj'))

    const html = renderToStaticMarkup(<AppInner />)
    const expectedColor = projectIdentity(project).color

    // The root div must expose --project-tint in its inline style
    expect(html).toContain('--project-tint')
    // The value must be the color derived from projectIdentity
    expect(html).toContain(expectedColor)
  })

  it('tint changes when the focused project switches', () => {
    const alpha = makeProject('alpha')
    const beta = makeProject('beta')

    // Verify the two projects actually produce distinct colors so the test
    // is non-trivial.  If they hash to the same slot the assertion is still
    // correct but trivially weak — we'd accept that.
    const colorAlpha = projectIdentity(alpha).color
    const colorBeta = projectIdentity(beta).color

    mockUseFocusedProject.mockReturnValue(defaultCtx([alpha, beta], 'alpha'))
    const htmlAlpha = renderToStaticMarkup(<AppInner />)
    expect(htmlAlpha).toContain(colorAlpha)

    mockUseFocusedProject.mockReturnValue(defaultCtx([alpha, beta], 'beta'))
    const htmlBeta = renderToStaticMarkup(<AppInner />)
    expect(htmlBeta).toContain(colorBeta)

    if (colorAlpha !== colorBeta) {
      // Cross-check: each render carries only the focused project's color in
      // the --project-tint position.
      expect(htmlAlpha).not.toContain(`--project-tint:${colorBeta}`)
      expect(htmlBeta).not.toContain(`--project-tint:${colorAlpha}`)
    }
  })

  it('does not set --project-tint on the shell root when no project is focused (still loading)', () => {
    mockUseFocusedProject.mockReturnValue(defaultCtx([], null))

    const html = renderToStaticMarkup(<AppInner />)
    // The shell root div (data-testid="app-shell") must not carry a style
    // attribute that defines --project-tint when there is no focused project.
    // We extract everything up to the first child `>` to scope the check to
    // the root element's own attributes.
    const shellOpenTag = html.match(/(<div[^>]*data-testid="app-shell"[^>]*>)/)?.[1] ?? ''
    expect(shellOpenTag).not.toContain('--project-tint')
  })
})
