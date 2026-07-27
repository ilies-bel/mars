/**
 * ContextRail component tests.
 *
 * Covers observable behaviour through the public interface:
 *   - The "Live tasks" panel is absent from the rail (replaced by session context).
 *   - The "Session artifacts" panel is present and open by default.
 *   - The "Project vision" panel is present.
 *   - ProjectVisionPanel renders vision content when VISION.md is available.
 *   - ProjectVisionPanel renders next-conversation-subject prompts when VISION.md
 *     is absent or unavailable.
 *   - SessionArtifactsPanel: files, created tasks, ADRs sections render.
 *   - Focus panel: renders the active thread title + status chip, or a
 *     "No active thread" placeholder when no thread is active.
 *
 * Uses renderToStaticMarkup for pure-HTML assertions (no interactive state).
 */

import { describe, it, expect } from 'bun:test'
import { vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextRail, ProjectVisionPanel, SessionArtifactsPanel } from './ContextRail'
import type { ActionQueueItem, ChatThreadDetail, ProgressTask } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// vi.hoisted ensures the state object is initialised before vi.mock factories run.
const mockState = vi.hoisted(() => ({
  queryOverride: null as ((opts: { queryKey: unknown[] }) => unknown) | null,
}))

// Shared state for useThreadFocus hook mocks.
const mockFocusState = vi.hoisted(() => ({
  aqItems: [] as ActionQueueItem[],
  historyItems: [] as ActionQueueItem[],
  tasks: null as ProgressTask[] | null,
}))

// All panels (Glossary, Skills, SessionArtifacts, Vision) call useQuery.
// The default returns isLoading=true (a safe "Loading…" state for most tests).
// Tests that need specific data can set mockState.queryOverride.
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    if (mockState.queryOverride) return mockState.queryOverride(opts)
    return { data: undefined, isLoading: true, isError: false }
  },
}))

// Mock the three hooks that useThreadFocus depends on so the test file does not
// require context providers (FocusedProjectProvider, QueryClientProvider, etc.).
vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({
    items: mockFocusState.aqItems,
    error: null,
    projectsError: null,
    projectsEmpty: false,
  }),
}))

vi.mock('@/entities/actionQueue/useActionQueueHistory', () => ({
  useActionQueueHistory: () => ({
    items: mockFocusState.historyItems,
    nextCursor: null,
    isLoadingMore: false,
    loadMore: () => {},
    error: null,
    projectsError: null,
    projectsEmpty: false,
  }),
}))

vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({
    tasks: mockFocusState.tasks,
    proposals: [],
    byCluster: { Queued: [], 'In progress': [], Blocked: [], Failed: [], Done: [] },
    aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 },
    error: null,
    connected: false,
  }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const renderRail = () => {
  mockState.queryOverride = null
  return renderToStaticMarkup(
    <ContextRail sessionStartedAt={0} onInsertPrompt={() => {}} />,
  )
}

// ---------------------------------------------------------------------------
// Absence of Live tasks panel
// ---------------------------------------------------------------------------

describe('ContextRail – Live tasks panel is absent', () => {
  it('does not render a "Live tasks" section header', () => {
    const html = renderRail()
    // Case-insensitive check: the section title must not appear anywhere.
    expect(html.toLowerCase()).not.toContain('live tasks')
  })

  it('does not render a status chip link to the Progress page', () => {
    const html = renderRail()
    // The Live tasks panel rendered status chips as links to #/progress?q=...
    expect(html).not.toContain('#/progress?q=')
  })

  it('does not render the context-rail-description test id', () => {
    const html = renderRail()
    // That test id was specific to Live tasks rows.
    expect(html).not.toContain('data-testid="context-rail-description"')
  })

  it('does not render the context-rail-status-link test id', () => {
    const html = renderRail()
    expect(html).not.toContain('data-testid="context-rail-status-link"')
  })
})

// ---------------------------------------------------------------------------
// Presence of session context panels
// ---------------------------------------------------------------------------

describe('ContextRail – session context panels are present', () => {
  it('renders the "Session artifacts" section header', () => {
    const html = renderRail()
    expect(html).toContain('Session artifacts')
  })

  it('renders the "Project vision" section header', () => {
    const html = renderRail()
    expect(html).toContain('Project vision')
  })

  it('renders the Glossary section header', () => {
    const html = renderRail()
    expect(html).toContain('Glossary')
  })

  it('renders the Skills section header', () => {
    const html = renderRail()
    expect(html).toContain('Skills')
  })
})

// ---------------------------------------------------------------------------
// ProjectVisionPanel — vision content
// ---------------------------------------------------------------------------

const renderVision = (visionData: string | null | undefined, isError = false) => {
  mockState.queryOverride = () => ({
    data: visionData,
    isLoading: false,
    isError,
  })
  const html = renderToStaticMarkup(<ProjectVisionPanel />)
  mockState.queryOverride = null
  return html
}

describe('ContextRail – ProjectVisionPanel with vision content', () => {
  it('renders vision content when VISION.md is available', () => {
    const html = renderVision('# Vision\nMars is a personal AI coding orchestrator.')
    expect(html).toContain('Mars is a personal AI coding orchestrator.')
    expect(html).toContain('data-testid="vision-content"')
  })

  it('does not render next-subject prompts when vision content is present', () => {
    const html = renderVision('# Vision\nSome vision content here.')
    expect(html).not.toContain('data-testid="vision-next-subject"')
  })

  it('truncates long vision content and shows an expand toggle', () => {
    const longContent = 'A'.repeat(400)
    const html = renderVision(longContent)
    expect(html).toContain('data-testid="vision-expand-toggle"')
    expect(html).toContain('show all')
  })

  it('does not show an expand toggle for short vision content', () => {
    const shortContent = 'Short vision.'
    const html = renderVision(shortContent)
    expect(html).not.toContain('data-testid="vision-expand-toggle"')
  })
})

describe('ContextRail – ProjectVisionPanel empty/unavailable states', () => {
  it('renders next-subject suggestions when vision content is null', () => {
    const html = renderVision(null)
    expect(html).toContain('data-testid="vision-next-subject"')
  })

  it('renders next-subject suggestions when VISION.md content is empty string', () => {
    const html = renderVision('')
    expect(html).toContain('data-testid="vision-next-subject"')
  })

  it('renders next-subject suggestions when query errors', () => {
    const html = renderVision(undefined, true)
    expect(html).toContain('data-testid="vision-next-subject"')
  })

  it('next-subject suggestions mention the project vision concept', () => {
    const html = renderVision(null)
    // The suggestions should guide the user toward a vision conversation.
    expect(html.toLowerCase()).toMatch(/vision|goal|question/)
  })

  it('does not render vision content element when VISION.md is unavailable', () => {
    const html = renderVision(null)
    expect(html).not.toContain('data-testid="vision-content"')
  })
})

// ---------------------------------------------------------------------------
// Session artifacts panel
// ---------------------------------------------------------------------------

/** Render SessionArtifactsPanel directly so we aren't blocked by the collapsed PanelSection. */
const renderArtifacts = (threadId?: string) => {
  mockState.queryOverride = null
  return renderToStaticMarkup(<SessionArtifactsPanel threadId={threadId} />)
}

// ---------------------------------------------------------------------------
// Focus panel
// ---------------------------------------------------------------------------

describe('ContextRail – Focus panel', () => {
  it('renders "No active thread" when no activeThreadId is supplied', () => {
    const html = renderRail()
    expect(html).toContain('Focus')
    expect(html).toContain('No active thread')
  })

  it('shows the thread title and status chip when activeThreadId + threadDetail are supplied', () => {
    mockState.queryOverride = null
    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-focus-1',
        title: 'My important thread',
        status: 'running',
        attentionStatus: 'generating',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 3,
        origin: null,
        alertItemId: null,
        alertResolved: false,
      },
      messages: [],
    }
    const html = renderToStaticMarkup(
      <ContextRail
        sessionStartedAt={0}
        onInsertPrompt={() => {}}
        activeThreadId="thread-focus-1"
        threadDetail={threadDetail}
        isStreaming={true}
      />,
    )
    expect(html).toContain('My important thread')
    expect(html).toContain('data-testid="focus-panel-status-chip"')
    expect(html).toContain('running')
  })

  it('shows "New thread" when threadDetail has a null title', () => {
    mockState.queryOverride = null
    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-focus-2',
        title: null,
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: null,
        alertItemId: null,
        alertResolved: false,
      },
      messages: [],
    }
    const html = renderToStaticMarkup(
      <ContextRail
        sessionStartedAt={0}
        onInsertPrompt={() => {}}
        activeThreadId="thread-focus-2"
        threadDetail={threadDetail}
        isStreaming={false}
      />,
    )
    expect(html).toContain('New thread')
    expect(html).toContain('idle')
  })
})


describe('ContextRail – SessionArtifactsPanel structure', () => {
  it('renders all three sub-section labels', () => {
    const html = renderArtifacts()
    expect(html).toContain('Files')
    expect(html).toContain('Created tasks')
    expect(html).toContain('Recent ADRs')
  })

  it('shows "No thread selected" for files when no threadId is provided', () => {
    const html = renderArtifacts(undefined)
    expect(html).toContain('No thread selected')
  })

  it('shows ADR loading state when no data is fetched yet (isLoading=true)', () => {
    // The default useQuery mock returns isLoading=true → "Loading…"
    const html = renderArtifacts(undefined)
    expect(html).toContain('Loading')
  })
})

describe('ContextRail – SessionArtifactsPanel with thread data', () => {
  it('shows task chips when thread has task-creating tool_use results', () => {
    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-1',
        title: null,
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 1,
        origin: null,
        alertItemId: null,
        alertResolved: false,
      },
      messages: [
        {
          id: 'msg-1',
          threadId: 'thread-1',
          role: 'assistant',
          segments: [
            {
              type: 'tool_use',
              toolName: 'Bash',
              input: 'mars task add "implement feature"',
              result: 'Task queued: mars-aabbccdd\nStatus: queued',
              isError: false,
              status: 'complete',
            },
          ],
          createdAt: '2024-01-01T00:00:00.000Z',
          feedback: null,
        },
      ],
    }

    mockState.queryOverride = (opts: { queryKey: unknown[] }) => {
      const [key] = opts.queryKey as string[]
      if (key === 'chat-thread') return { data: threadDetail, isLoading: false, isError: false }
      return { data: undefined, isLoading: true, isError: false }
    }

    const html = renderToStaticMarkup(<SessionArtifactsPanel threadId="thread-1" />)
    mockState.queryOverride = null

    expect(html).toContain('mars-aabbccdd')
    expect(html).toContain('data-testid="session-artifacts-task-chip"')
  })

  it('shows uploaded file names from attachment segments', () => {
    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-2',
        title: null,
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 1,
        origin: null,
        alertItemId: null,
        alertResolved: false,
      },
      messages: [
        {
          id: 'msg-2',
          threadId: 'thread-2',
          role: 'user',
          segments: [
            {
              type: 'attachment',
              path: 'thread-2/uuid.png',
              mimeType: 'image/png',
              name: 'screenshot.png',
            },
          ],
          createdAt: '2024-01-01T00:00:00.000Z',
          feedback: null,
        },
      ],
    }

    mockState.queryOverride = (opts: { queryKey: unknown[] }) => {
      const [key] = opts.queryKey as string[]
      if (key === 'chat-thread') return { data: threadDetail, isLoading: false, isError: false }
      return { data: undefined, isLoading: true, isError: false }
    }

    const html = renderToStaticMarkup(<SessionArtifactsPanel threadId="thread-2" />)
    mockState.queryOverride = null

    expect(html).toContain('screenshot.png')
  })

  it('shows ADRs from the /api/adrs endpoint', () => {
    mockState.queryOverride = (opts: { queryKey: unknown[] }) => {
      const [key] = opts.queryKey as string[]
      if (key === 'adrs') {
        return {
          data: [{ number: 42, title: 'My ADR title', slug: 'my-adr-title' }],
          isLoading: false,
          isError: false,
        }
      }
      return { data: undefined, isLoading: true, isError: false }
    }

    const html = renderToStaticMarkup(<SessionArtifactsPanel />)
    mockState.queryOverride = null

    expect(html).toContain('My ADR title')
    expect(html).toContain('#42')
  })

  it('shows "No ADRs yet" when the ADR list is empty', () => {
    mockState.queryOverride = (opts: { queryKey: unknown[] }) => {
      const [key] = opts.queryKey as string[]
      if (key === 'adrs') return { data: [], isLoading: false, isError: false }
      return { data: undefined, isLoading: true, isError: false }
    }

    const html = renderToStaticMarkup(<SessionArtifactsPanel />)
    mockState.queryOverride = null

    expect(html).toContain('No ADRs yet')
  })
})

// ---------------------------------------------------------------------------
// Focus panel – linked entity via useThreadFocus
// ---------------------------------------------------------------------------

describe('ContextRail – FocusPanel linked entity', () => {
  it('alert-linked thread: shows kind badge and entity title', () => {
    const alertItem: ActionQueueItem = {
      id: 'alert-item-1',
      entityId: 'wt-123',
      kind: 'stale-worktree',
      title: 'Stale worktree in branch task-abc',
      body: 'Worktree has been stale for 24 hours',
      at: '2024-01-01T00:00:00.000Z',
      priority: 'normal',
      dag: null,
      errorKind: '',
      actions: [],
      humanSummary: '',
      verbs: [],
      staleWorktreeDetail: {
        prompt: null,
        status: 'done',
        ageHours: 24,
        updatedAt: '2024-01-01T00:00:00.000Z',
        branch: 'task-abc',
        empty: false,
        investigation: null,
      },
    }
    mockFocusState.aqItems = [alertItem]

    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-alert-1',
        title: 'Alert thread',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: 'alert',
        alertItemId: 'alert-item-1',
        alertResolved: false,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        sessionStartedAt={0}
        onInsertPrompt={() => {}}
        activeThreadId="thread-alert-1"
        threadDetail={threadDetail}
      />,
    )
    mockFocusState.aqItems = []

    // Kind badge uses kindBadgeLabel('stale-worktree') = 'stale wt'
    expect(html).toContain('data-testid="focus-panel-kind-badge"')
    expect(html).toContain('stale wt')
    // Entity title is rendered
    expect(html).toContain('Stale worktree in branch task-abc')
  })

  it('task-linked thread: shows task badge, prompt excerpt, and task status', () => {
    const alertItem: ActionQueueItem = {
      id: 'alert-item-2',
      entityId: 'task-xyz',
      kind: 'failed-task',
      title: 'Task failed',
      body: 'Verification did not pass',
      at: '2024-01-01T00:00:00.000Z',
      priority: 'high',
      dag: null,
      errorKind: 'verify',
      actions: [],
      humanSummary: '',
      verbs: [],
    }
    const taskEntity: ProgressTask = {
      id: 'task-xyz',
      prompt: 'Implement the new feature for users',
      status: 'failed',
      plan: null,
      branch: null,
      worktreePath: null,
      error: 'Verification failed',
      dropReason: null,
      retryCount: 0,
      blockedBy: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      cluster: 'Failed',
    }
    mockFocusState.aqItems = [alertItem]
    mockFocusState.tasks = [taskEntity]

    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-task-1',
        title: 'Task thread',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: 'alert',
        alertItemId: 'alert-item-2',
        alertResolved: false,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        sessionStartedAt={0}
        onInsertPrompt={() => {}}
        activeThreadId="thread-task-1"
        threadDetail={threadDetail}
      />,
    )
    mockFocusState.aqItems = []
    mockFocusState.tasks = null

    // Kind badge shows 'task'
    expect(html).toContain('data-testid="focus-panel-kind-badge"')
    expect(html).toContain('>task<')
    // Task prompt rendered
    expect(html).toContain('Implement the new feature for users')
    // Task status chip
    expect(html).toContain('data-testid="focus-panel-status-chip"')
    expect(html).toContain('failed')
  })

  it('unlinked thread: shows thread title and status, no kind badge', () => {
    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-unlinked',
        title: 'My unlinked thread',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: null,
        alertItemId: null,
        alertResolved: false,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        sessionStartedAt={0}
        onInsertPrompt={() => {}}
        activeThreadId="thread-unlinked"
        threadDetail={threadDetail}
      />,
    )

    // Thread title and status from slice 1 fallback
    expect(html).toContain('My unlinked thread')
    expect(html).toContain('data-testid="focus-panel-status-chip"')
    // No linked-entity badge
    expect(html).not.toContain('data-testid="focus-panel-kind-badge"')
  })
})
