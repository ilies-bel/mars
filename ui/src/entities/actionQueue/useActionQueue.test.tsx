/**
 * Behaviour tests for the empty-registry and stale-server failure modes,
 * rendered through the chat page (which absorbed the action queue as
 * projection Threads in its sidebar).
 *
 * Root cause originally fixed: with per-project ?project= scoping,
 * focusedProjectId is null when GET /api/projects returns an empty list. The
 * old `enabled: projectId !== null` gate silently prevented any fetch,
 * leaving every panel blank with no error — indistinguishable from
 * "genuinely no work".
 *
 * Two distinct failure modes under test:
 *   1. Empty registry  — /api/projects succeeds but returns [] → show an
 *      actionable "no projects registered" message (not the generic "No items").
 *   2. Stale UI server — /api/projects 404s → surface the ApiErrorPanel.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FocusedProjectProvider } from '@/shared/useFocusedProject'
import { ChatPage } from '@/pages/ChatPage'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Mock useActionQueue so ChatPage rendering can be tested without a real API
// server. The hook's return value is fully controlled per test.
// ---------------------------------------------------------------------------

vi.mock('@/entities/actionQueue/useActionQueue')
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
const mockUseActionQueue = vi.mocked(useActionQueue)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeQc = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  // Keep the history / chat-threads queries settled so the sidebar renders
  // deterministically under renderToStaticMarkup.
  qc.setQueryData(['action-queue-history', null], { rows: [], nextCursor: null })
  qc.setQueryData(['chat-threads', undefined], [])
  return qc
}

function renderPage(qc: QueryClient = makeQc()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <FocusedProjectProvider>
        <ChatPage />
      </FocusedProjectProvider>
    </QueryClientProvider>,
  )
}

const BASE_ITEM: ActionQueueItem = {
  id: 'item-1',
  kind: 'failed-task',
  entityId: 'task-abc',
  priority: 'normal',
  title: 'Task needs attention',
  body: 'The task failed with an error.',
  at: '2026-01-01T00:00:00Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
  diagnosis: null,
}

// ---------------------------------------------------------------------------
// AC1: Empty registry → actionable "No projects registered" message, NOT blank
// ---------------------------------------------------------------------------

describe('ChatPage sidebar – empty registry', () => {
  beforeEach(() => {
    mockUseActionQueue.mockReturnValue({
      items: [],
      error: null,
      projectsError: null,
      projectsEmpty: true,
    })
  })

  it('shows an actionable "no projects registered" message instead of a blank panel', () => {
    const html = renderPage()
    expect(html).toContain('No projects registered')
  })

  it('includes the mars init command as the primary fix', () => {
    const html = renderPage()
    expect(html).toContain('mars init')
  })

  it('includes mars project add as an alternative fix', () => {
    const html = renderPage()
    expect(html).toContain('mars project add')
  })

  it('does NOT render the generic "No items." empty state', () => {
    const html = renderPage()
    expect(html).not.toContain('No items.')
  })

  it('renders the no-projects-registered testid so it is detectable in e2e tests', () => {
    const html = renderPage()
    expect(html).toContain('no-projects-registered')
  })
})

// ---------------------------------------------------------------------------
// AC2: /api/projects fails (stale UI server 404) → ApiErrorPanel shown, NOT blank
// ---------------------------------------------------------------------------

describe('ChatPage sidebar – stale UI server (fetchProjects 404)', () => {
  const staleServerError = new Error('GET /api/projects → 404')

  beforeEach(() => {
    mockUseActionQueue.mockReturnValue({
      items: [],
      error: null,
      projectsError: staleServerError,
      projectsEmpty: false,
    })
  })

  it('renders the api-error-panel testid when projectsError is set', () => {
    const html = renderPage()
    expect(html).toContain('api-error-panel')
  })

  it('does NOT render the blank "No items." state', () => {
    const html = renderPage()
    expect(html).not.toContain('No items.')
  })

  it('does NOT render the no-projects-registered message (wrong error path)', () => {
    const html = renderPage()
    expect(html).not.toContain('No projects registered')
  })
})

// ---------------------------------------------------------------------------
// AC3: Empty registry but server's --repo default returns items (option a)
// ---------------------------------------------------------------------------

describe('ChatPage sidebar – option (a) fallback: empty registry + items from server default', () => {
  beforeEach(() => {
    mockUseActionQueue.mockReturnValue({
      items: [BASE_ITEM],
      error: null,
      projectsError: null,
      projectsEmpty: true,
    })
  })

  it('renders the item title as a projection Thread when the server default answered', () => {
    const html = renderPage()
    expect(html).toContain(BASE_ITEM.title)
  })

  it('does NOT show the "No projects registered" message when items exist', () => {
    const html = renderPage()
    expect(html).not.toContain('No projects registered')
  })

  it('does NOT show the generic "No items." state', () => {
    const html = renderPage()
    expect(html).not.toContain('No items.')
  })
})

// ---------------------------------------------------------------------------
// AC4: Genuine "no pending items" state is distinct from the empty-registry state
// ---------------------------------------------------------------------------

describe('ChatPage sidebar – genuine "no items" (registry has projects, queue empty)', () => {
  beforeEach(() => {
    mockUseActionQueue.mockReturnValue({
      items: [],
      error: null,
      projectsError: null,
      projectsEmpty: false,
    })
  })

  it('shows the "No items." generic message when registry has projects but queue is empty', () => {
    const html = renderPage()
    expect(html).toContain('No items.')
  })

  it('does NOT show the "No projects registered" message', () => {
    const html = renderPage()
    expect(html).not.toContain('No projects registered')
  })
})
