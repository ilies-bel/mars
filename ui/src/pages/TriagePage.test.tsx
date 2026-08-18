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
const mockCreateChatThread = vi.fn().mockResolvedValue({ id: 'new-thread-id' })

vi.mock('@/shared/api', () => ({
  invokeAction: (...args: unknown[]) => mockInvokeAction(...args),
  postDecision: (...args: unknown[]) => mockPostDecision(...args),
  createChatThread: (...args: unknown[]) => mockCreateChatThread(...args),
}))

const mockStartThreadFromAlert = vi.fn().mockResolvedValue({ threadId: 'alert-thread-id' })
vi.mock('@/entities/alerts/api', () => ({
  startThreadFromAlert: (...args: unknown[]) => mockStartThreadFromAlert(...args),
}))

const mockFocusedProjectId = vi.fn<[], string | null>().mockReturnValue(null)
vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => mockFocusedProjectId(),
}))

const mockItems = vi.fn<[], ActionQueueItem[]>().mockReturnValue([])
const mockQueueError = vi.fn<[], Error | null>().mockReturnValue(null)
vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: mockItems(), error: mockQueueError() }),
}))

const mockProposalsError = vi.fn<[], string | null>().mockReturnValue(null)
vi.mock('@/entities/proposals/useProposals', () => ({
  useProposals: () => ({
    proposals: [],
    error: mockProposalsError(),
    isPending: false,
    connected: true,
    refetch: vi.fn(),
  }),
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
  mockQueueError.mockReturnValue(null)
  mockProposalsError.mockReturnValue(null)
  mockFocusedProjectId.mockReturnValue(null)
  window.location.hash = ''
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

  it('still renders the Chat → control', () => {
    const { container } = renderPage()
    const chatButton = container.querySelector('[data-testid="triage-chat"]')
    expect(chatButton).not.toBeNull()
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

  it('clicking Restart does NOT immediately call invokeAction — it opens an in-app confirm', async () => {
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-restart"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    expect(mockInvokeAction).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="triage-restart-confirm"]')).not.toBeNull()
  })

  it('confirm text names the discarded work (entity id)', async () => {
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-restart"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const confirmEl = container.querySelector('[data-testid="triage-restart-confirm"]')
    expect(confirmEl?.textContent).toContain('task-failed')
    expect(confirmEl?.textContent).toMatch(/discard|lose|losing/i)
  })

  it('confirm text includes the branch when humanDetail.branch is present', async () => {
    mockItems.mockReturnValue([
      makeItem('failed', { humanDetail: { branch: 'task/mars-abc123' } }),
    ])
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-restart"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const confirmEl = container.querySelector('[data-testid="triage-restart-confirm"]')
    expect(confirmEl?.textContent).toContain('task/mars-abc123')
  })

  it('clicking "Yes, discard & restart" in the confirm step calls invokeAction("restart", entityId)', async () => {
    const { container } = renderPage()
    const restartBtn = container.querySelector('[data-testid="triage-restart"]') as HTMLButtonElement
    await act(async () => {
      restartBtn.click()
    })
    const confirmYesBtn = container.querySelector(
      '[data-testid="triage-restart-confirm-yes"]',
    ) as HTMLButtonElement
    expect(confirmYesBtn).not.toBeNull()
    await act(async () => {
      confirmYesBtn.click()
    })
    expect(mockInvokeAction).toHaveBeenCalledWith('restart', 'task-failed')
  })

  it('clicking Cancel in the confirm step dismisses it without dispatching', async () => {
    const { container } = renderPage()
    const restartBtn = container.querySelector('[data-testid="triage-restart"]') as HTMLButtonElement
    await act(async () => {
      restartBtn.click()
    })
    const cancelBtn = container.querySelector(
      '[data-testid="triage-restart-cancel"]',
    ) as HTMLButtonElement
    expect(cancelBtn).not.toBeNull()
    await act(async () => {
      cancelBtn.click()
    })
    expect(mockInvokeAction).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="triage-restart-confirm"]')).toBeNull()
    // The demoted Restart button is back, ready to be clicked again.
    expect(container.querySelector('[data-testid="triage-restart"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TriageRow — task id is reachable (evidence before a destroy-or-resume call)
// ---------------------------------------------------------------------------

describe('TriageRow – task id is a link to the task detail drawer', () => {
  it('renders the entity id as a link into #/task/<id>', () => {
    mockItems.mockReturnValue([makeItem('failed', { entityId: 'mars-bff7e039' })])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('data-testid="triage-entity-link"')
    expect(html).toContain('href="#/task/mars-bff7e039?from=triage"')
    expect(html).toContain('mars-bff7e039')
  })

  it('non-task-backed kinds (reflect-recommended) keep the entity id as plain text', () => {
    mockItems.mockReturnValue([makeItem('reflect-recommended', { entityId: 'refl-1' })])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).not.toContain('data-testid="triage-entity-link"')
  })
})

// ---------------------------------------------------------------------------
// TriageRow — recovery-exhausted rows get carry-forward CLI hints, not
// Continue/Restart (mars continue refuses non-zero on these).
// ---------------------------------------------------------------------------

describe('TriageRow – recovery-exhausted rows surface carry-forward options', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        entityId: 'mars-abc123',
        failureReasonCode: 'recovery_exhausted:verify/unclassified',
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

  it('renders the recovery-exhausted carry-forward panel with mars remerge / --supersede hints', () => {
    const { container } = renderPage()
    const panel = container.querySelector('[data-testid="triage-recovery-exhausted"]')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('mars remerge mars-abc123')
    expect(panel?.textContent).toContain('mars task add --supersede mars-abc123')
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

// ---------------------------------------------------------------------------
// TriageRow — Chat control opens a thread for the row and navigates to it
// ---------------------------------------------------------------------------

describe('TriageRow – Chat control opens a thread and navigates', () => {
  it('arc-failed row: calls startThreadFromAlert with entityId, navigates to #/chat?thread=<id>', async () => {
    mockItems.mockReturnValue([makeItem('arc-failed', { entityId: 'arc-xyz' })])
    mockStartThreadFromAlert.mockResolvedValueOnce({ threadId: 'alert-thread-id' })
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    expect(mockStartThreadFromAlert).toHaveBeenCalledWith('arc-xyz')
    expect(mockCreateChatThread).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/chat?thread=alert-thread-id')
  })

  it('non-arc-failed row: calls createChatThread seeded from the row, navigates to #/chat?thread=<id>', async () => {
    mockItems.mockReturnValue([
      makeItem('failed', { entityId: 'task-failed', humanSummary: 'Deploy step broke' }),
    ])
    mockCreateChatThread.mockResolvedValueOnce({ id: 'new-thread-id' })
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(mockStartThreadFromAlert).not.toHaveBeenCalled()
    expect(mockCreateChatThread).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Deploy step broke', origin: 'failed' }),
    )
    expect(window.location.hash).toBe('#/chat?thread=new-thread-id')
  })

  it('preserves the focused project id in the navigation hash', async () => {
    mockFocusedProjectId.mockReturnValue('proj-1')
    mockItems.mockReturnValue([makeItem('failed')])
    mockCreateChatThread.mockResolvedValueOnce({ id: 'new-thread-id' })
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(mockCreateChatThread).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1' }),
    )
    expect(window.location.hash).toBe('#/chat?thread=new-thread-id&project=proj-1')
  })

  it('shows error feedback when thread resolution fails', async () => {
    mockItems.mockReturnValue([makeItem('failed')])
    mockCreateChatThread.mockRejectedValueOnce(new Error('Daemon unreachable'))
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const errorEl = container.querySelector('[data-testid="triage-error"]')
    expect(errorEl).not.toBeNull()
    expect(errorEl?.textContent).toContain('Daemon unreachable')
  })
})

// ---------------------------------------------------------------------------
// Feed resilience — a single failing feed must not blank the page
// ---------------------------------------------------------------------------

describe('TriagePage – proposals feed rejects but action-queue items still render', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([makeItem('failed')])
    mockProposalsError.mockReturnValue(
      'GET /api/proposals → response failed schema validation',
    )
  })

  it('renders the action-queue item when proposals fetch errors', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).not.toBeNull()
  })

  it('shows an inline proposals feed error card', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-feed-error-proposals"]')).not.toBeNull()
  })

  it('does not show the All-quiet empty state', () => {
    const { container } = renderPage()
    expect(container.textContent).not.toContain('All quiet')
  })
})

describe('TriagePage – action-queue feed rejects but proposals error still surfaces', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([])
    mockQueueError.mockReturnValue(new Error('Cannot reach daemon'))
    mockProposalsError.mockReturnValue(null)
  })

  it('shows an inline action-queue feed error card', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-feed-error-action-queue"]')).not.toBeNull()
  })

  it('does not show the All-quiet empty state when the queue fetch failed', () => {
    // The error card IS the content — "all quiet" should not appear
    const { container } = renderPage()
    expect(container.textContent).not.toContain('All quiet')
  })
})
