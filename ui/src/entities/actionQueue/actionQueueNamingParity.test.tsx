// @vitest-environment happy-dom
/**
 * Regression test for the "four different names" bug: the sidebar nav, the
 * TriagePage header, and the `?` keyboard-shortcuts overlay used to call the
 * same surface three different things ("Needs you", "Needs you", and
 * "action queue (triage)"), so a user reading the shortcut overlay could not
 * tell that `t` goes to the entry the sidebar calls "Needs you".
 *
 * "action queue" is the term of record (it is what the glossary, ADR-0057,
 * and the CLI already use). This test pins the sidebar label
 * (`SHELL_NAV_GROUPS`), the rendered TriagePage header, and the rendered
 * shortcuts-overlay entry for `t` to all agree on that name, so a future
 * rename of one surface without the others fails loudly here instead of
 * shipping silently.
 */

import { vi, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// ---------------------------------------------------------------------------
// Module mocks — TriagePage pulls in several data hooks; stub them the same
// way TriagePage.test.tsx does so it renders with an empty, quiet queue.
// ---------------------------------------------------------------------------

vi.mock('@/shared/api', () => ({
  invokeAction: vi.fn().mockResolvedValue(undefined),
  postDecision: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  startThreadForQueueItem: vi.fn().mockResolvedValue({ id: 'thread-id' }),
}))

vi.mock('@/entities/alerts/api', () => ({
  startThreadFromAlert: vi.fn().mockResolvedValue({ threadId: 'thread-id' }),
}))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
  useFocusedProject: () => ({
    projects: [{ projectId: 'p_test', repoRoot: '/repo', name: 'repo', health: 'live' }],
    focusedProjectId: 'p_test',
    setFocusedProjectId: () => {},
    projectsSettled: true,
    projectsError: null,
  }),
}))

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: [], error: null }),
}))

vi.mock('@/entities/proposals/useProposals', () => ({
  useProposals: () => ({ proposals: [], error: null, isPending: false, connected: true, refetch: vi.fn() }),
}))

vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({
    byCluster: { 'In progress': [] },
    aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 },
  }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('@/shared/time', () => ({
  relativeTime: () => '1m ago',
}))

vi.mock('@/shared/alertCause', () => ({
  deriveCause: () => undefined,
}))

const { SHELL_NAV_GROUPS } = await import('@/widgets/Shell')
const { TriagePage } = await import('@/pages/TriagePage')
const { ShortcutsOverlay } = await import('@/widgets/ShortcutsOverlay')

describe('action-queue naming parity — sidebar, page header, and shortcut overlay agree', () => {
  it('all three surfaces name the surface "action queue"', () => {
    const sidebarEntry = SHELL_NAV_GROUPS.flatMap((g) => g.entries).find(
      (e) => e.route === 'triage',
    )
    expect(sidebarEntry?.label.toLowerCase()).toBe('action queue')

    const headerHtml = renderToStaticMarkup(<TriagePage />)
    expect(headerHtml.toLowerCase()).toContain('action queue')

    const overlayHtml = renderToStaticMarkup(<ShortcutsOverlay onClose={() => {}} />)
    expect(overlayHtml.toLowerCase()).toContain('action queue')

    // None of the three surfaces should leak the internal `triage` route id
    // into user-facing copy.
    expect(sidebarEntry?.label.toLowerCase()).not.toContain('triage')
    expect(headerHtml.toLowerCase()).not.toMatch(/>\s*needs you\s*</)
    expect(overlayHtml.toLowerCase()).not.toContain('(triage)')
  })
})
