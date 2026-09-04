/**
 * Navigation coverage — every app route is reachable from the sidebar.
 *
 * Asserts:
 *   1. Steward (#/steward) has a sidebar entry in the Advanced group.
 *   2. Studio (#/studio/<id>) has a sidebar entry in the Advanced group.
 *   3. Every full-page RouteName is represented in SHELL_NAV_GROUPS.
 *   4. The reflections RunStateBanner does not concatenate two sentences
 *      without a space (the ".Run manually" defect pattern).
 *
 * Static shape tests against nav data and rendered HTML; no DOM needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SHELL_NAV_GROUPS } from './widgets/Shell'

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock('@/shared/useHashRoute', () => ({
  useHashRoute: vi.fn(() => '#/reflections'),
}))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProject: vi.fn(() => ({
    focusedProjectId: null,
    projects: [],
    projectsSettled: true,
    projectsError: null,
    setFocusedProjectId: () => {},
  })),
}))

vi.mock('@tanstack/react-query', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: vi.fn() }
})

import { useQuery } from '@tanstack/react-query'
import { ReflectionsPage } from './pages/ReflectionsPage'
import type { DeepReflectionsListResponse } from '@/shared/api'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeListResponse = (
  overrides: Partial<DeepReflectionsListResponse> = {},
): DeepReflectionsListResponse => ({
  reports: [],
  totalDiscovered: 0,
  unreadableCount: 0,
  lastReflectedAt: null,
  autoRunReflect: 'off',
  autoEnqueue: false,
  ...overrides,
})

const mockQueryResult = <T,>(opts: {
  data?: T
  isLoading?: boolean
  error?: Error | null
}) => ({
  data: opts.data,
  isLoading: opts.isLoading ?? false,
  error: opts.error ?? null,
  isError: opts.error != null,
  isSuccess: opts.data !== undefined,
})

// ---------------------------------------------------------------------------
// Sidebar coverage
// ---------------------------------------------------------------------------

describe('Navigation coverage — sidebar entries', () => {
  const allEntries = SHELL_NAV_GROUPS.flatMap((g) => g.entries)
  const allRoutes = allEntries.map((e) => e.route)
  const allLabels = allEntries.map((e) => e.label)

  it('Steward is in the sidebar', () => {
    expect(allRoutes).toContain('steward')
    expect(allLabels).toContain('Steward')
  })

  it('Steward sidebar entry links to #/steward', () => {
    const entry = allEntries.find((e) => e.route === 'steward')
    expect(entry?.href).toBe('#/steward')
  })

  it('Studio is in the sidebar', () => {
    expect(allRoutes).toContain('studio')
    expect(allLabels).toContain('Studio')
  })

  it('all full-page routes that have a dedicated URL are represented in the sidebar', () => {
    // arc-qa is a detail route accessed from task/progress; it deliberately
    // has no top-level sidebar entry.
    const SIDEBAR_EXEMPT: string[] = ['arc-qa']
    const representedRoutes = new Set(allRoutes)
    const expectedRoutes = [
      'triage',
      'proposals',
      'progress',
      'chat',
      'control',
      'kpi',
      'events',
      'reflections',
      'steward',
      'studio',
    ]
    for (const route of expectedRoutes) {
      if (!SIDEBAR_EXEMPT.includes(route)) {
        expect(representedRoutes.has(route), `route '${route}' missing from sidebar`).toBe(true)
      }
    }
  })

  it('every icon in SHELL_NAV_GROUPS is unique', () => {
    const icons = allEntries.map((e) => e.icon)
    const unique = new Set(icons)
    expect(unique.size).toBe(icons.length)
  })

  it('the wordmark glyph ◆ is not reused as a nav icon', () => {
    const icons = allEntries.map((e) => e.icon)
    expect(icons).not.toContain('◆')
  })

  it('Steward and Studio are in the Advanced (collapsible) group', () => {
    const advanced = SHELL_NAV_GROUPS.find((g) => g.collapsible)
    expect(advanced).toBeDefined()
    const advancedRoutes = advanced!.entries.map((e) => e.route)
    expect(advancedRoutes).toContain('steward')
    expect(advancedRoutes).toContain('studio')
  })
})

// ---------------------------------------------------------------------------
// Reflections banner — no sentence concatenation
//
// The RunStateBanner component is internal to ReflectionsPage, so we test
// through the full page render using the same mock pattern as
// ReflectionsPage.test.tsx.  The banner is rendered on the list view
// whenever listData is present.
// ---------------------------------------------------------------------------

describe('Reflections banner — no sentence concatenation', () => {
  beforeEach(() => {
    // Render the list view with auto-reflect OFF — this is the path that
    // originally produced "automatically.Run manually" (missing space).
    vi.mocked(useQuery)
      .mockReset()
      .mockReturnValueOnce(
        mockQueryResult({
          data: makeListResponse({ autoRunReflect: 'off', autoEnqueue: false }),
        }),
      )
      .mockReturnValueOnce(mockQueryResult({ data: undefined }))
  })

  it('run-state banner text has no period directly adjacent to a capital letter', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)

    // Locate the run-state banner element
    const bannerMatch = html.match(/data-testid="run-state-banner"[^>]*>([\s\S]*?)<\/div>/)
    expect(bannerMatch, 'run-state-banner not found in rendered output').not.toBeNull()
    // Strip HTML tags to get the raw text content
    const textContent = bannerMatch![1].replace(/<[^>]+>/g, '')
    // A period immediately followed by an uppercase letter (no whitespace) is
    // the concatenation defect — original bug: "automatically.Run manually".
    expect(textContent, `Banner text has sentence concatenation: "${textContent}"`).not.toMatch(
      /\.[A-Z]/,
    )
  })

  it('list view does not show the <originId> placeholder', () => {
    const html = renderToStaticMarkup(<ReflectionsPage />)
    // The list view has no known originId; showing a placeholder sends the
    // operator on a dead-end search for an id the page cannot supply.
    expect(html).not.toContain('&lt;originId&gt;')
  })
})
