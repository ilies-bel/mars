/**
 * ContextRail component tests.
 *
 * Covers observable behaviour through the public interface:
 *   - The thread-scoped artifact rail presents Tasks, Files, and Meta.
 *   - Focus panel: renders the active thread title + status chip, or a
 *     "No active thread" placeholder when no thread is active.
 *
 * Uses renderToStaticMarkup for pure-HTML assertions (no interactive state).
 */

import { describe, it, expect } from 'bun:test'
import { vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ArtifactsRail, ContextRail } from './ContextRail'
import type { ActionQueueItem, ChatThreadDetail, ProgressTask } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// vi.hoisted ensures the state object is initialised before vi.mock factories run.
const mockState = vi.hoisted(() => ({
  queryOverride: null as ((opts: { queryKey: unknown[] }) => unknown) | null,
  threadTasks: {} as Record<string, string[]>,
}))

// Shared state for useThreadFocus hook mocks.
const mockFocusState = vi.hoisted(() => ({
  aqItems: [] as ActionQueueItem[],
  historyItems: [] as ActionQueueItem[],
  tasks: null as ProgressTask[] | null,
}))

// Query-backed panels call useQuery.
// The default returns isLoading=true (a safe "Loading…" state for most tests).
// Tests that need specific data can set mockState.queryOverride.
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    if (opts.queryKey[0] === 'thread-tasks') {
      return {
        data: mockState.threadTasks[String(opts.queryKey[1])] ?? [],
        isLoading: false,
        isError: false,
      }
    }
    if (mockState.queryOverride) return mockState.queryOverride(opts)
    return { data: undefined, isLoading: true, isError: false }
  },
  // FocusVerbsRow calls useQueryClient for cache invalidation after verb dispatch.
  useQueryClient: () => ({
    invalidateQueries: () => Promise.resolve(),
  }),
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
    <ContextRail />,
  )
}

// ---------------------------------------------------------------------------
// Presence of thread context panels
// ---------------------------------------------------------------------------

describe('ContextRail – thread context panels are present', () => {
  it('renders the four artifact section headers', () => {
    const html = renderRail()
    expect(html).toContain('Tasks')
    expect(html).toContain('Files')
    expect(html).toContain('ADRs')
    expect(html).toContain('Meta')
  })

  it('renders the Glossary section header', () => {
    const html = renderRail()
    expect(html).toContain('Glossary')
  })

})

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
        activeThreadId="thread-focus-2"
        threadDetail={threadDetail}
        isStreaming={false}
      />,
    )
    expect(html).toContain('New thread')
    expect(html).toContain('idle')
  })
})


describe('ContextRail – artifact rail', () => {
  it('renders only tasks linked to the selected thread and shows an empty state for an unlinked thread', () => {
    mockState.threadTasks = {
      'thread-with-tasks': ['mars-linked-one', 'mars-linked-two'],
      'thread-without-tasks': [],
    }

    const linkedHtml = renderToStaticMarkup(
      <ContextRail
        threadId="thread-with-tasks"
        activeThreadId="thread-with-tasks"
      />,
    )
    const emptyHtml = renderToStaticMarkup(
      <ContextRail
        threadId="thread-without-tasks"
        activeThreadId="thread-without-tasks"
      />,
    )
    mockState.threadTasks = {}

    expect(linkedHtml.match(/data-testid="context-rail-task-row"/g)).toHaveLength(2)
    expect(linkedHtml).toContain('mars-linked-one')
    expect(linkedHtml).toContain('mars-linked-two')
    expect(emptyHtml).toContain('No tasks created in this thread')
  })

  it('renders linked task, file, and project-meta sections', () => {
    const html = renderToStaticMarkup(
      <ArtifactsRail
        tasks={['mars-aabbccdd']}
        files={[{ type: 'attachment', path: 'thread-1/design.png', mimeType: 'image/png', name: 'Design draft' }]}
        meta={{ vision: 'One operator surface', theme: 'Lean and local-first' }}
      />,
    )

    expect(html).toContain('Tasks')
    expect(html).toContain('Files')
    expect(html).toContain('Meta')
    expect(html).toContain('Task mars-aabbccdd')
    expect(html).toContain('Design draft')
    expect(html).toContain('Project vision')
    expect(html).toContain('Project theme')
    expect(html).toContain('#/task/mars-aabbccdd?from=chat')
    expect(html).toContain('/api/chat/uploads/thread-1%2Fdesign.png')
  })

  const renderEmptyArtifactRail = () => renderToStaticMarkup(
    <ArtifactsRail tasks={[]} files={[]} meta={{ vision: null, theme: null }} />,
  )

  describe('Tasks section', () => {
    it('keeps a subdued placeholder when no tasks were created', () => {
      expect(renderEmptyArtifactRail()).toContain('No tasks created in this thread')
    })
  })

  describe('Files section', () => {
    it('keeps a subdued placeholder when the thread has no attachments', () => {
      expect(renderEmptyArtifactRail()).toContain('No files shared in this thread')
    })
  })

  describe('Meta section', () => {
    it('keeps a subdued placeholder when the project has no vision or theme', () => {
      expect(renderEmptyArtifactRail()).toContain('No project vision or theme recorded')
    })
  })

  describe('ADRs section', () => {
    it('constructs ADR links using docs/knowledge/decisions/ path', () => {
      mockState.queryOverride = (opts: { queryKey: unknown[] }) => {
        if (opts.queryKey[0] === 'adrs') {
          return {
            data: [{ number: 42, title: 'Keep the rail focused', slug: 'keep-the-rail-focused' }],
            isLoading: false,
            isError: false,
          }
        }
        return { data: undefined, isLoading: true, isError: false }
      }
      const html = renderToStaticMarkup(
        <ArtifactsRail tasks={[]} files={[]} meta={{ vision: null, theme: null }} />,
      )
      mockState.queryOverride = null
      // The path is URL-encoded in the href attribute
      const expectedEncodedPath = encodeURIComponent('docs/knowledge/decisions/0042-keep-the-rail-focused.md')
      expect(html).toContain(expectedEncodedPath)
      expect(html).not.toContain('docs%2Fadr%2F')
    })
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
      kind: 'failed',
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

  // ---------------------------------------------------------------------------
  // Done criteria subsection
  // ---------------------------------------------------------------------------

  it('done criteria list renders for a task fixture with two done criteria', () => {
    const alertItem: ActionQueueItem = {
      id: 'alert-criteria-1',
      entityId: 'task-criteria-1',
      kind: 'failed',
      title: 'Task with criteria',
      body: '',
      at: '2024-01-01T00:00:00.000Z',
      priority: 'high',
      dag: null,
      errorKind: 'verify',
      actions: [],
      humanSummary: '',
      verbs: [],
    }
    const taskWithCriteria: ProgressTask = {
      id: 'task-criteria-1',
      prompt: 'Build the feature',
      status: 'failed',
      plan: null,
      branch: null,
      worktreePath: null,
      error: null,
      dropReason: null,
      retryCount: 0,
      blockedBy: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      cluster: 'Failed',
      doneCriteria: ['First criterion', 'Second criterion'],
      verify: 'cd ui && npx vitest run',
    }
    mockFocusState.aqItems = [alertItem]
    mockFocusState.tasks = [taskWithCriteria]

    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-criteria-1',
        title: 'Criteria thread',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: 'alert',
        alertItemId: 'alert-criteria-1',
        alertResolved: false,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        activeThreadId="thread-criteria-1"
        threadDetail={threadDetail}
      />,
    )
    mockFocusState.aqItems = []
    mockFocusState.tasks = null

    expect(html).toContain('data-testid="done-criteria-list"')
    expect(html).toContain('First criterion')
    expect(html).toContain('Second criterion')
    expect(html).toContain('data-testid="done-criteria-verify"')
    expect(html).toContain('cd ui &amp;&amp; npx vitest run')
  })

  it('done criteria section is absent for an alert-only thread', () => {
    const alertItem: ActionQueueItem = {
      id: 'alert-alert-1',
      entityId: 'wt-alert-1',
      kind: 'stale-worktree',
      title: 'Stale worktree',
      body: '',
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
        ageHours: 10,
        updatedAt: '2024-01-01T00:00:00.000Z',
        branch: 'task-abc',
        empty: false,
        investigation: null,
      },
    }
    mockFocusState.aqItems = [alertItem]

    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-alert-only',
        title: 'Alert-only thread',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: 'alert',
        alertItemId: 'alert-alert-1',
        alertResolved: false,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        activeThreadId="thread-alert-only"
        threadDetail={threadDetail}
      />,
    )
    mockFocusState.aqItems = []

    expect(html).not.toContain('data-testid="done-criteria-list"')
    expect(html).not.toContain('Done criteria')
  })

  it('done criteria section is absent for a task with empty done_criteria and no verify', () => {
    const alertItem: ActionQueueItem = {
      id: 'alert-empty-1',
      entityId: 'task-empty-1',
      kind: 'failed',
      title: 'Task without criteria',
      body: '',
      at: '2024-01-01T00:00:00.000Z',
      priority: 'high',
      dag: null,
      errorKind: 'verify',
      actions: [],
      humanSummary: '',
      verbs: [],
    }
    const taskNoCriteria: ProgressTask = {
      id: 'task-empty-1',
      prompt: 'A task with no spec criteria',
      status: 'failed',
      plan: null,
      branch: null,
      worktreePath: null,
      error: null,
      dropReason: null,
      retryCount: 0,
      blockedBy: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      cluster: 'Failed',
      doneCriteria: [],
      verify: null,
    }
    mockFocusState.aqItems = [alertItem]
    mockFocusState.tasks = [taskNoCriteria]

    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-empty-1',
        title: 'Empty criteria thread',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: 'alert',
        alertItemId: 'alert-empty-1',
        alertResolved: false,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        activeThreadId="thread-empty-1"
        threadDetail={threadDetail}
      />,
    )
    mockFocusState.aqItems = []
    mockFocusState.tasks = null

    expect(html).not.toContain('data-testid="done-criteria-list"')
    expect(html).not.toContain('Done criteria')
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

// ---------------------------------------------------------------------------
// FocusPanel verbs row (slice 5 — operator actions rail)
// ---------------------------------------------------------------------------

describe('ContextRail – FocusPanel verbs row', () => {
  it('renders verb buttons for an alert fixture with two verbs', () => {
    const alertItem: ActionQueueItem = {
      id: 'alert-verbs-1',
      entityId: 'task-abc',
      kind: 'stale-worktree',
      title: 'Stale worktree alert',
      body: '',
      at: '2024-01-01T00:00:00.000Z',
      priority: 'normal',
      dag: null,
      errorKind: '',
      actions: [],
      humanSummary: '',
      verbs: [
        { op: 'diagnose', label: 'Diagnose', style: 'primary' },
        { op: 'purge', label: 'Purge', style: 'destructive' },
      ],
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
        id: 'thread-verbs-1',
        title: 'Alert thread with verbs',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: 'alert',
        alertItemId: 'alert-verbs-1',
        alertResolved: false,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        activeThreadId="thread-verbs-1"
        threadDetail={threadDetail}
      />,
    )
    mockFocusState.aqItems = []

    expect(html).toContain('data-testid="focus-verbs-row"')
    expect(html).toContain('data-testid="focus-verb-diagnose"')
    expect(html).toContain('Diagnose')
    expect(html).toContain('data-testid="focus-verb-purge"')
    expect(html).toContain('Purge')
  })

  it('does not render the verbs row for a task-only fixture', () => {
    const alertItem: ActionQueueItem = {
      id: 'alert-task-only',
      entityId: 'task-xyz',
      kind: 'failed',
      title: 'Task failed',
      body: '',
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
      prompt: 'Implement the thing',
      status: 'failed',
      plan: null,
      branch: null,
      worktreePath: null,
      error: null,
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
        id: 'thread-task-only',
        title: 'Task thread',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: 'alert',
        alertItemId: 'alert-task-only',
        alertResolved: false,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        activeThreadId="thread-task-only"
        threadDetail={threadDetail}
      />,
    )
    mockFocusState.aqItems = []
    mockFocusState.tasks = null

    // Task-linked threads show the task view (ProgressTask path), not verbs row
    expect(html).not.toContain('data-testid="focus-verbs-row"')
  })

  it('disables verb buttons when the alert is resolved', () => {
    const alertItem: ActionQueueItem = {
      id: 'alert-resolved-1',
      entityId: 'wt-resolved',
      kind: 'stale-worktree',
      title: 'Resolved alert',
      body: '',
      at: '2024-01-01T00:00:00.000Z',
      priority: 'normal',
      dag: null,
      errorKind: '',
      actions: [],
      humanSummary: '',
      verbs: [
        { op: 'restart', label: 'Restart', style: 'primary' },
      ],
      staleWorktreeDetail: {
        prompt: null,
        status: 'done',
        ageHours: 48,
        updatedAt: '2024-01-01T00:00:00.000Z',
        branch: 'task-resolved',
        empty: false,
        investigation: null,
      },
    }
    mockFocusState.aqItems = [alertItem]

    const threadDetail: ChatThreadDetail = {
      thread: {
        id: 'thread-resolved-1',
        title: 'Resolved alert thread',
        status: 'idle',
        attentionStatus: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        messageCount: 0,
        origin: 'alert',
        alertItemId: 'alert-resolved-1',
        alertResolved: true,
      },
      messages: [],
    }

    const html = renderToStaticMarkup(
      <ContextRail
        activeThreadId="thread-resolved-1"
        threadDetail={threadDetail}
      />,
    )
    mockFocusState.aqItems = []

    // Verbs row is present (non-empty verbs)
    expect(html).toContain('data-testid="focus-verbs-row"')
    // Button carries the disabled attribute
    expect(html).toContain('data-testid="focus-verb-restart"')
    expect(html).toContain('disabled')
  })
})
