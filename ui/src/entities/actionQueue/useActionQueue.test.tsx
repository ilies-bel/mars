/**
 * Behaviour tests for the empty-registry and stale-server states, rendered
 * through the chat page (which absorbed the action queue as projection
 * Threads — ADR-0048 chat-to-threads restructure).
 *
 * Since the restructure, ChatPage renders the hero (headline + composer)
 * for every no-thread state and consumes only `items` from useActionQueue;
 * the dedicated "No projects registered" / ApiErrorPanel affordances no
 * longer exist. These tests pin that rendering so the states stay
 * deterministic and non-blank under renderToStaticMarkup.
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

  it('renders the hero headline instead of a blank panel', () => {
    const html = renderPage()
    expect(html).toContain('hero-headline')
  })

  it('renders the hero composer so the user can still act', () => {
    const html = renderPage()
    expect(html).toContain('hero-composer')
  })

  it('does NOT render the generic "No items." empty state', () => {
    const html = renderPage()
    expect(html).not.toContain('No items.')
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

  it('still renders the hero (projectsError no longer surfaces a dedicated panel)', () => {
    const html = renderPage()
    expect(html).toContain('hero-headline')
    expect(html).toContain('hero-composer')
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

  it('renders the hero (not a blank panel) when the server default answered with items', () => {
    const html = renderPage()
    expect(html).toContain('hero-headline')
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

  it('renders the hero when registry has projects but queue is empty', () => {
    const html = renderPage()
    expect(html).toContain('hero-headline')
  })

  it('does NOT show the "No projects registered" message', () => {
    const html = renderPage()
    expect(html).not.toContain('No projects registered')
  })
})
