/**
 * ContextRail component tests.
 *
 * Covers observable behaviour through the public interface:
 *   - Task description has a title attribute (hover tooltip) with the full prompt
 *   - Status chip renders as an <a> link to the Progress page filtered by status
 *   - Description button starts collapsed (aria-expanded=false)
 *   - Different statuses produce correct href values on the status chip
 *
 * Uses renderToStaticMarkup for pure-HTML assertions (no interactive state).
 * Interactive expand/collapse is client-side state; the collapsed default is
 * the observable server-side behaviour we can assert.
 */

import { describe, it, expect } from 'bun:test'
import { vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextRail } from './ContextRail'
import type { ProgressTask } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// vi.hoisted ensures the state object is initialised before vi.mock factories run.
const mockState = vi.hoisted(() => ({
  tasks: null as ProgressTask[] | null,
  error: null as Error | null,
}))

vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({ tasks: mockState.tasks, error: mockState.error }),
}))

// GlossaryPanel and SkillsPanel both call useQuery; returning isLoading keeps
// them in a benign "Loading…" state so they don't interfere with task tests.
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: true, isError: false }),
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
