import { describe, it, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProgressTask } from '@/shared/schemas'
import { ActiveTasksPanel } from './ActiveTasksPanel'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const task = (
  overrides: Partial<ProgressTask> & { id: string },
): ProgressTask => ({
  id: overrides.id,
  prompt: overrides.prompt ?? `Task ${overrides.id}`,
  status: overrides.status ?? 'running',
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  blockedBy: [],
  spec: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  cluster: 'In progress',
  parentProposalId: null,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('ActiveTasksPanel – empty state', () => {
  it('shows an empty-state message when no tasks are active', () => {
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[]} />)
    expect(html).toContain('No active tasks')
  })

  it('renders the panel heading regardless of task count', () => {
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[]} />)
    expect(html).toContain('Currently worked on')
  })
})

// ---------------------------------------------------------------------------
// Task listing
// ---------------------------------------------------------------------------

describe('ActiveTasksPanel – task listing', () => {
  it('renders only the first line of the prompt as the visible label', () => {
    const t = task({ id: 't1', prompt: 'Add login page\nWith OAuth support' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    // First line is the visible text content
    expect(html).toContain('Add login page')
    // Second line must NOT appear as visible text (it may appear in a title attribute)
    // The element contains the first line as its text node; additional lines are suppressed
    // by the split — only the first segment is passed as children.
    expect(html).not.toMatch(/>With OAuth support</)
  })

  it('renders all active tasks', () => {
    const t1 = task({ id: 't1', prompt: 'Task Alpha' })
    const t2 = task({ id: 't2', prompt: 'Task Beta' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t1, t2]} />)
    expect(html).toContain('Task Alpha')
    expect(html).toContain('Task Beta')
  })

  it('does not show empty-state message when tasks are present', () => {
    const t = task({ id: 't1', prompt: 'Some task' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).not.toContain('No active tasks')
  })
})

// ---------------------------------------------------------------------------
// Step strip – all four step labels present
// ---------------------------------------------------------------------------

describe('ActiveTasksPanel – step strip labels', () => {
  it('renders all four step labels for each task', () => {
    const t = task({ id: 't1', prompt: 'My task', status: 'running' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).toContain('setup')
    expect(html).toContain('code')
    expect(html).toContain('verify')
    expect(html).toContain('merge')
  })
})

// ---------------------------------------------------------------------------
// Step strip – active step derived from task.status
// ---------------------------------------------------------------------------

describe('ActiveTasksPanel – step highlight from status', () => {
  it('highlights the code step for a running task', () => {
    const t = task({ id: 't1', status: 'running' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    // The active step should carry an aria-current attribute
    expect(html).toContain('aria-current')
    // "code" should be the active step
    expect(html).toMatch(/aria-current[^>]*>[^<]*code|code[^<]*aria-current/)
  })

  it('highlights the verify step for a verifying task', () => {
    const t = task({ id: 't1', status: 'verifying' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).toMatch(/aria-current[^>]*>[^<]*verify|verify[^<]*aria-current/)
  })

  it('highlights the merge step for a merging task', () => {
    const t = task({ id: 't1', status: 'merging' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).toMatch(/aria-current[^>]*>[^<]*merge|merge[^<]*aria-current/)
  })

  it('highlights the merge step for a vega-reconciling task', () => {
    const t = task({ id: 't1', status: 'vega-reconciling', cluster: 'In progress' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).toMatch(/aria-current[^>]*>[^<]*merge|merge[^<]*aria-current/)
  })
})

// ---------------------------------------------------------------------------
// Step strip – active step driven by task.currentStep
// ---------------------------------------------------------------------------

describe('ActiveTasksPanel – step highlight from currentStep field', () => {
  it('uses currentStep over status-derived step when present', () => {
    // status says 'running' (code), but currentStep overrides to 'verify'
    const t = task({ id: 't1', status: 'running', currentStep: 'verify' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).toMatch(/aria-current[^>]*>[^<]*verify|verify[^<]*aria-current/)
  })

  it('uses currentStep = setup correctly', () => {
    const t = task({ id: 't1', status: 'running', currentStep: 'setup' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).toMatch(/aria-current[^>]*>[^<]*setup|setup[^<]*aria-current/)
  })

  it('falls back to status-derived step when currentStep is null', () => {
    const t = task({ id: 't1', status: 'merging', currentStep: null })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).toMatch(/aria-current[^>]*>[^<]*merge|merge[^<]*aria-current/)
  })
})

// ---------------------------------------------------------------------------
// Step strip – completed steps marked done
// ---------------------------------------------------------------------------

describe('ActiveTasksPanel – completed steps', () => {
  it('marks steps before the active step as completed', () => {
    // For a verifying task: setup + code are done, verify is active, merge is upcoming
    const t = task({ id: 't1', status: 'verifying' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    // Completed steps carry data-done="true"
    expect(html).toContain('data-done="true"')
  })

  it('marks no steps as done for a setup-phase task', () => {
    const t = task({ id: 't1', status: 'running', currentStep: 'setup' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    expect(html).not.toContain('data-done="true"')
  })

  it('marks setup + code + verify as done for a merging task', () => {
    const t = task({ id: 't1', status: 'merging' })
    const html = renderToStaticMarkup(<ActiveTasksPanel tasks={[t]} />)
    // Three steps are done (setup, code, verify)
    const matches = html.match(/data-done="true"/g) ?? []
    expect(matches.length).toBe(3)
  })
})
