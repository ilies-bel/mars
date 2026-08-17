// @vitest-environment happy-dom
/**
 * TriagePage component tests.
 *
 * Covers:
 *   - Per-kind button sets (task recovery kinds show Continue+Restart;
 *     daemon-code-drift shows server verbs; reflect-recommended shows no buttons)
 *   - Mutations fired on click (invokeAction called with correct op + entityId)
 *   - Decision button fires postDecision and hides the row on success
 *   - Error shown inline when a mutation fails
 *   - Draft-proposal cluster row links to #/proposals (not #/progress)
 */

import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { TriagePage } from './TriagePage'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports resolve
// ---------------------------------------------------------------------------

const mockInvokeAction = vi.fn().mockResolvedValue(undefined)
const mockPostDecision = vi.fn<[], Promise<Response>>().mockResolvedValue(
  new Response(null, { status: 200 }),
)

vi.mock('@/shared/api', () => ({
  invokeAction: (...args: unknown[]) => mockInvokeAction(...args),
  postDecision: (...args: unknown[]) => mockPostDecision(...args),
}))

const mockItems = vi.fn<[], ActionQueueItem[]>().mockReturnValue([])
vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: mockItems(), error: null }),
}))

vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({
    byCluster: { 'In progress': [] },
    aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 },
  }),
}))

const mockInvalidateQueries = vi.fn().mockResolvedValue(undefined)
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}))

vi.mock('@/shared/time', () => ({
  relativeTime: () => '1m ago',
}))

vi.mock('@/shared/alertCause', () => ({
  deriveCause: () => undefined,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid ActionQueueItem fixture for any task-failure kind. */
const makeItem = (
  kind: string,
  overrides: Partial<ActionQueueItem> = {},
): ActionQueueItem =>
  ({
    id: `item-${kind}`,
    entityId: `task-${kind}`,
    kind,
    priority: 'normal' as const,
    title: `Title for ${kind}`,
    body: '',
    at: '2026-01-01T00:00:00Z',
    dag: null,
    errorKind: kind,
    actions: [],
    decisions: [],
    humanSummary: `Summary for ${kind}`,
    humanDetail: undefined,
    verbs: [],
    arcGoal: null,
    diagnosis: null,
    failureReasonCode: null,
    fixForTaskId: null,
    resolution: null,
    devServerUrl: null,
    snoozeUntil: undefined,
    ...overrides,
  }) as ActionQueueItem

function renderPage(): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<TriagePage />)
  })
  return { container, root }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
  mockItems.mockReturnValue([])
})

// ---------------------------------------------------------------------------
// Cluster row — link target
// ---------------------------------------------------------------------------

describe('TriageClusterRow – draft-proposal link target', () => {
  it('links to #/proposals, not #/progress', () => {
    mockItems.mockReturnValue([
      makeItem('draft-proposal', { kind: 'draft-proposal' } as Partial<ActionQueueItem>),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('href="#/proposals"')
    expect(html).not.toContain('href="#/progress"')
  })

  it('labels the link "Review proposals →"', () => {
    mockItems.mockReturnValue([
      makeItem('draft-proposal', { kind: 'draft-proposal' } as Partial<ActionQueueItem>),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('Review proposals →')
  })
})

// ---------------------------------------------------------------------------
// TriageRow — per-kind button sets (DOM rendering)
// ---------------------------------------------------------------------------

describe('TriageRow – failed kind shows Continue + Restart', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([makeItem('failed')])
  })

  it('renders a Continue button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).not.toBeNull()
  })

  it('renders a Restart button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).not.toBeNull()
  })
})

describe('TriageRow – daemon-code-drift does NOT show Continue/Restart', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([
      makeItem('daemon-code-drift', {
        verbs: [{ op: 'restart-daemon', label: 'Restart daemon', style: 'primary' }],
      }),
    ])
  })

  it('has no Continue button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).toBeNull()
  })

  it('has no Restart button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).toBeNull()
  })

  it('renders the server-provided verb button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-restart-daemon"]')).not.toBeNull()
  })
})

describe('TriageRow – reflect-recommended shows no action buttons', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([makeItem('reflect-recommended')])
  })

  it('has no Continue button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).toBeNull()
  })

  it('has no Restart button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).toBeNull()
  })

  it('still renders the Chat → link', () => {
    const { container } = renderPage()
    const chatLink = container.querySelector('a[href="#/chat"]')
    expect(chatLink).not.toBeNull()
  })
})

describe('TriageRow – gate-enrichment shows decisions, no Continue/Restart', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([
      makeItem('gate-enrichment', {
        decisions: [
          {
            label: 'Approve',
            endpoint: '/api/gate/approve',
            payload: { taskId: 'task-gate-enrichment' },
          },
          {
            label: 'Retire',
            endpoint: '/api/gate/retire',
            payload: { taskId: 'task-gate-enrichment' },
          },
        ],
      }),
    ])
  })

  it('has no Continue button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).toBeNull()
  })

  it('has no Restart button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).toBeNull()
  })

  it('renders the Approve decision button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-decision-Approve"]')).not.toBeNull()
  })

  it('renders the Retire decision button', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-decision-Retire"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TriageRow — mutations fired on click
// ---------------------------------------------------------------------------

describe('TriageRow – Continue/Restart buttons fire invokeAction', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([makeItem('failed')])
  })

  it('clicking Continue calls invokeAction("continue", entityId)', async () => {
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-continue"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    // dispatchAlertVerb → invokeAction('continue', entityId) for non-process-level ops
    expect(mockInvokeAction).toHaveBeenCalledWith('continue', 'task-failed')
  })

  it('clicking Restart calls invokeAction("restart", entityId)', async () => {
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-restart"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    expect(mockInvokeAction).toHaveBeenCalledWith('restart', 'task-failed')
  })
})

describe('TriageRow – daemon-code-drift verb fires invokeAction without entityId', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([
      makeItem('daemon-code-drift', {
        verbs: [{ op: 'restart-daemon', label: 'Restart daemon', style: 'primary' }],
      }),
    ])
  })

  it('calls invokeAction("restart-daemon", undefined) — process-level op', async () => {
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-verb-restart-daemon"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    // PROCESS_LEVEL_OPS.has('restart-daemon') → entityId is undefined
    expect(mockInvokeAction).toHaveBeenCalledWith('restart-daemon', undefined)
  })
})

describe('TriageRow – decision button fires postDecision', () => {
  const decision = {
    label: 'Approve',
    endpoint: '/api/gate/approve',
    payload: { taskId: 'gate-task' },
  }

  beforeEach(() => {
    mockItems.mockReturnValue([makeItem('gate-enrichment', { decisions: [decision] })])
  })

  it('calls postDecision with the decision object on click', async () => {
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-decision-Approve"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    expect(mockPostDecision).toHaveBeenCalledWith(decision)
  })

  it('row disappears on successful decision (resolved)', async () => {
    mockPostDecision.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-decision-Approve"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(container.querySelector('[data-testid="triage-decision-Approve"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TriageRow — error feedback
// ---------------------------------------------------------------------------

describe('TriageRow – error feedback shown when mutation fails', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([makeItem('failed')])
  })

  it('shows error text when invokeAction rejects', async () => {
    mockInvokeAction.mockRejectedValueOnce(new Error('Daemon unreachable'))
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-continue"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const errorEl = container.querySelector('[data-testid="triage-error"]')
    expect(errorEl).not.toBeNull()
    expect(errorEl?.textContent).toContain('Daemon unreachable')
  })

  it('row stays visible after a failed action (not resolved)', async () => {
    mockInvokeAction.mockRejectedValueOnce(new Error('Daemon unreachable'))
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-continue"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    // Continue button still present — row was not resolved on failure
    expect(container.querySelector('[data-testid="triage-continue"]')).not.toBeNull()
  })

  it('shows error when decision response is non-2xx', async () => {
    mockItems.mockReturnValue([
      makeItem('gate-enrichment', {
        decisions: [{ label: 'Approve', endpoint: '/api/gate/approve', payload: {} }],
      }),
    ])
    mockPostDecision.mockResolvedValueOnce(new Response(null, { status: 500 }))
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-decision-Approve"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const errorEl = container.querySelector('[data-testid="triage-error"]')
    expect(errorEl).not.toBeNull()
    expect(errorEl?.textContent).toContain('500')
  })
})
