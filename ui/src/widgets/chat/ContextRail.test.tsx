/**
 * ContextRail component tests.
 *
 * Covers observable behaviour through the public interface:
 *   - Task description has a title attribute (hover tooltip) with the full prompt
 *   - Status chip renders as an <a> link to the Progress page filtered by status
 *   - Description button starts collapsed (aria-expanded=false)
 *   - Different statuses produce correct href values on the status chip
 *   - Session artifacts panel: renders with 3 sections (files, tasks, ADRs)
 *
 * Uses renderToStaticMarkup for pure-HTML assertions (no interactive state).
 * Interactive expand/collapse is client-side state; the collapsed default is
 * the observable server-side behaviour we can assert.
 */

import { describe, it, expect } from 'bun:test'
import { vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextRail, SessionArtifactsPanel } from './ContextRail'
import type { ProgressTask, ChatThreadDetail } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// vi.hoisted ensures the state object is initialised before vi.mock factories run.
const mockState = vi.hoisted(() => ({
  tasks: null as ProgressTask[] | null,
  error: null as Error | null,
  queryOverride: null as ((opts: { queryKey: unknown[] }) => unknown) | null,
}))

vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({ tasks: mockState.tasks, error: mockState.error }),
}))

// GlossaryPanel, SkillsPanel, and SessionArtifactsPanel all call useQuery.
// The default returns isLoading=true (a safe "Loading…" state for most tests).
// Tests that need specific data can set mockState.queryOverride.
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    if (mockState.queryOverride) return mockState.queryOverride(opts)
    return { data: undefined, isLoading: true, isError: false }
  },
}))

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const LONG_PROMPT =
  'drag-drop, paste, mic input handling for the composer widget — needs end-to-end test coverage'

const TASK: ProgressTask = {
  id: 't-1',
  prompt: LONG_PROMPT,
  status: 'queued',
  createdAt: new Date(0).toISOString(),
} as ProgressTask

const render = (tasks: ProgressTask[] | null = [TASK], error: Error | null = null) => {
  mockState.tasks = tasks
  mockState.error = error
  return renderToStaticMarkup(
    <ContextRail sessionStartedAt={0} onInsertPrompt={() => {}} />,
  )
}

// ---------------------------------------------------------------------------
// Tooltip (title attribute)
// ---------------------------------------------------------------------------

describe('ContextRail – description tooltip', () => {
  it('description button has a title attribute containing the full prompt', () => {
    const html = render()
    expect(html).toContain(`title="${LONG_PROMPT}"`)
  })

  it('description has the correct data-testid', () => {
    const html = render()
    expect(html).toContain('data-testid="context-rail-description"')
  })

  it('full prompt text appears in the rendered output', () => {
    const html = render()
    expect(html).toContain(LONG_PROMPT)
  })
})

// ---------------------------------------------------------------------------
// Status chip link
// ---------------------------------------------------------------------------

describe('ContextRail – status chip link', () => {
  it('status chip renders as an <a> element (not a span)', () => {
    const html = render()
    // The data-testid must be on an <a> tag
    expect(html).toMatch(/<a[^>]*data-testid="context-rail-status-link"/)
  })

  it('status chip href links to progress page with status as query', () => {
    const html = render()
    expect(html).toContain('href="#/progress?q=queued"')
  })

  it('failed status chip links to progress filtered by "failed"', () => {
    const html = render([{ ...TASK, status: 'failed' } as ProgressTask])
    expect(html).toContain('href="#/progress?q=failed"')
  })

  it('blocked status chip links to progress filtered by "blocked"', () => {
    const html = render([{ ...TASK, status: 'blocked' } as ProgressTask])
    expect(html).toContain('href="#/progress?q=blocked"')
  })

  it('running status chip links to progress filtered by "running"', () => {
    const html = render([{ ...TASK, status: 'running' } as ProgressTask])
    expect(html).toContain('href="#/progress?q=running"')
  })

  it('status chip has an aria-label for screen readers', () => {
    const html = render()
    expect(html).toContain('aria-label="Filter tasks by status: queued"')
  })
})

// ---------------------------------------------------------------------------
// Expand / collapse initial state
// ---------------------------------------------------------------------------

describe('ContextRail – description collapse default', () => {
  it('description button starts collapsed (aria-expanded=false)', () => {
    const html = render()
    expect(html).toContain('aria-expanded="false"')
  })

  it('collapsed description has line-clamp class', () => {
    const html = render()
    expect(html).toContain('line-clamp-2')
  })
})

// ---------------------------------------------------------------------------
// Sorting and filtering
// ---------------------------------------------------------------------------

describe('ContextRail – live tasks panel sort and filter', () => {
  it('excludes done tasks whose updatedAt is older than 24 hours', () => {
    const oldDoneTask: ProgressTask = {
      ...TASK,
      id: 'done-old',
      prompt: 'old done task',
      status: 'done',
      cluster: 'Done',
      updatedAt: new Date(0).toISOString(), // epoch — clearly > 24h ago
    } as ProgressTask
    const html = render([oldDoneTask])
    expect(html).not.toContain('old done task')
    // Panel has no active rows left, falls back to empty state
    expect(html).toContain('No active tasks')
  })

  it('includes done tasks whose updatedAt is within the last 24 hours', () => {
    const recentDoneTask: ProgressTask = {
      ...TASK,
      id: 'done-recent',
      prompt: 'recent done task',
      status: 'done',
      cluster: 'Done',
      updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    } as ProgressTask
    const html = render([recentDoneTask])
    expect(html).toContain('recent done task')
  })

  it('sorts running tasks before queued tasks regardless of updatedAt', () => {
    // Queued task has a more recent updatedAt — without priority sort it would appear first.
    const queuedTask: ProgressTask = {
      ...TASK,
      id: 'q-1',
      prompt: 'queued task',
      status: 'queued',
      cluster: 'Queued',
      updatedAt: new Date(Date.now() - 1000).toISOString(), // 1 s ago (newer)
    } as ProgressTask
    const runningTask: ProgressTask = {
      ...TASK,
      id: 'r-1',
      prompt: 'running task',
      status: 'running',
      cluster: 'In progress',
      updatedAt: new Date(Date.now() - 3600 * 1000).toISOString(), // 1 h ago (older)
    } as ProgressTask
    const html = render([queuedTask, runningTask])
    // Running task must appear earlier in the HTML than the queued task
    expect(html.indexOf('running task')).toBeLessThan(html.indexOf('queued task'))
  })

  it('sorts verifying tasks before queued tasks', () => {
    const queuedTask: ProgressTask = {
      ...TASK,
      id: 'q-2',
      prompt: 'another queued',
      status: 'queued',
      cluster: 'Queued',
      updatedAt: new Date(Date.now() - 500).toISOString(),
    } as ProgressTask
    const verifyingTask: ProgressTask = {
      ...TASK,
      id: 'v-1',
      prompt: 'verifying task',
      status: 'verifying',
      cluster: 'In progress',
      updatedAt: new Date(Date.now() - 7200 * 1000).toISOString(), // 2 h ago
    } as ProgressTask
    const html = render([queuedTask, verifyingTask])
    expect(html.indexOf('verifying task')).toBeLessThan(html.indexOf('another queued'))
  })

  it('sorts queued tasks before blocked tasks', () => {
    const blockedTask: ProgressTask = {
      ...TASK,
      id: 'b-1',
      prompt: 'blocked task',
      status: 'blocked',
      cluster: 'Blocked',
      updatedAt: new Date(Date.now() - 100).toISOString(),
    } as ProgressTask
    const queuedTask: ProgressTask = {
      ...TASK,
      id: 'q-3',
      prompt: 'third queued',
      status: 'queued',
      cluster: 'Queued',
      updatedAt: new Date(Date.now() - 7200 * 1000).toISOString(),
    } as ProgressTask
    const html = render([blockedTask, queuedTask])
    expect(html.indexOf('third queued')).toBeLessThan(html.indexOf('blocked task'))
  })

  it('within same status, sorts by updatedAt descending (most recently updated first)', () => {
    const olderQueued: ProgressTask = {
      ...TASK,
      id: 'q-old',
      prompt: 'older queued',
      status: 'queued',
      cluster: 'Queued',
      updatedAt: new Date(Date.now() - 3600 * 1000).toISOString(), // 1 h ago
    } as ProgressTask
    const newerQueued: ProgressTask = {
      ...TASK,
      id: 'q-new',
      prompt: 'newer queued',
      status: 'queued',
      cluster: 'Queued',
      updatedAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 min ago
    } as ProgressTask
    const html = render([olderQueued, newerQueued])
    expect(html.indexOf('newer queued')).toBeLessThan(html.indexOf('older queued'))
  })
})

// ---------------------------------------------------------------------------
// Error / empty states
// ---------------------------------------------------------------------------

describe('ContextRail – live tasks panel states', () => {
  it('shows "Tasks unavailable" when useProgress returns an error', () => {
    const html = render(null, new Error('daemon unreachable'))
    expect(html).toContain('Tasks unavailable')
  })

  it('shows "Loading…" when tasks is null (loading state)', () => {
    const html = render(null)
    expect(html).toContain('Loading')
  })

  it('shows "No active tasks" when the task list is empty', () => {
    const html = render([])
    expect(html).toContain('No active tasks')
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

describe('ContextRail – session artifacts panel header in rail', () => {
  it('renders the "Session artifacts" section header inside ContextRail', () => {
    mockState.tasks = []
    mockState.error = null
    const html = renderToStaticMarkup(
      <ContextRail sessionStartedAt={0} onInsertPrompt={() => {}} />,
    )
    expect(html).toContain('Session artifacts')
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
