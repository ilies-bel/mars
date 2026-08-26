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
// Non-task-failure rows now go through startThreadForQueueItem, which dedups
// on the row id and seeds the thread with a proactive opener. The generic
// createChatThread it used to call knew nothing about the row: it minted a new
// thread per click and opened it blank.
const mockStartThreadForQueueItem = vi.fn().mockResolvedValue({ id: 'new-thread-id' })

vi.mock('@/shared/api', () => ({
  invokeAction: (...args: unknown[]) => mockInvokeAction(...args),
  postDecision: (...args: unknown[]) => mockPostDecision(...args),
  startThreadForQueueItem: (...args: unknown[]) => mockStartThreadForQueueItem(...args),
}))

const mockStartThreadFromAlert = vi.fn().mockResolvedValue({ threadId: 'alert-thread-id' })
vi.mock('@/entities/alerts/api', () => ({
  startThreadFromAlert: (...args: unknown[]) => mockStartThreadFromAlert(...args),
}))

const mockFocusedProjectId = vi.fn<[], string | null>().mockReturnValue(null)
const mockDaemonHealth = vi
  .fn<[], 'live' | 'degraded' | 'down'>()
  .mockReturnValue('live')

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => mockFocusedProjectId(),
  // TriagePage reads the focused project's probed health to decide whether an
  // empty queue means "nothing to do" or "the daemon can't answer".
  useFocusedProject: () => ({
    projects: [
      {
        projectId: 'p_test',
        repoRoot: '/repo',
        name: 'repo',
        health: mockDaemonHealth(),
      },
    ],
    focusedProjectId: 'p_test',
    setFocusedProjectId: () => {},
    projectsSettled: true,
    projectsError: null,
  }),
}))

const mockItems = vi.fn<[], ActionQueueItem[]>().mockReturnValue([])
const mockQueueError = vi.fn<[], Error | null>().mockReturnValue(null)
const mockQueuePending = vi.fn<[], boolean>().mockReturnValue(false)
vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({
    items: mockItems(),
    error: mockQueueError(),
    isPending: mockQueuePending(),
  }),
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

/**
 * Minimal valid ActionQueueItem fixture for any task-failure kind. `dag`
 * defaults to a populated (non-null) context — the common case of a row
 * genuinely backed by a task row the drawer can resolve. Tests exercising a
 * non-task-backed row (a signature slug, gate slug, or other non-task
 * entityId) must override `dag: null` explicitly, matching what the daemon
 * actually sends for those rows.
 */
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
    dag: { blockers: [], blocking: [], descendants: [], proposalId: null, edges: [] },
    errorKind: kind,
    actions: [],
    decisions: [],
    humanSummary: `Summary for ${kind}`,
    humanDetail: undefined,
    verbs: [],
    arcGoal: null,
    operatorGoal: null,
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
  mockQueuePending.mockReturnValue(false)
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

describe('TriageRow – the daemon restart verb does not double the Restart control', () => {
  beforeEach(() => {
    // What the `failed` recipe actually ships. The bare `restart` verb fires on
    // first click; the row's own Restart is gated behind a confirm that names
    // the branch and says what is lost. Rendering both put two Restart buttons
    // side by side, the destructive one unguarded.
    mockItems.mockReturnValue([
      makeItem('failed', {
        verbs: [
          { op: 'restart', label: 'Restart', style: 'primary' },
          { op: 'purge', label: 'Discard task', style: 'destructive' },
          { op: 'dismiss', label: 'Dismiss', style: 'default' },
        ],
      }),
    ])
  })

  it('drops the daemon restart verb', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-restart"]')).toBeNull()
  })

  it('keeps the guarded Restart control', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).not.toBeNull()
  })

  it('keeps every other daemon verb — only restart is duplicated', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-purge"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="triage-verb-dismiss"]')).not.toBeNull()
  })

  it('leaves the restart verb alone on a kind with no built-in restart control', () => {
    // daemon-code-drift is not a task-recovery kind, so its server verb is the
    // only restart affordance there and must survive.
    mockItems.mockReturnValue([
      makeItem('daemon-code-drift', {
        verbs: [{ op: 'restart', label: 'Restart daemon', style: 'primary' }],
      }),
    ])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-restart"]')).not.toBeNull()
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
  it('renders the entity id as a link into #/task/<id> (real task id, non-null dag)', () => {
    mockItems.mockReturnValue([makeItem('failed', { entityId: 'mars-bff7e039' })])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('data-testid="triage-entity-link"')
    expect(html).toContain('href="#/task/mars-bff7e039?from=triage"')
    expect(html).toContain('mars-bff7e039')
  })

  it('non-task-backed kinds (reflect-recommended) keep the entity id as plain text', () => {
    mockItems.mockReturnValue([
      makeItem('reflect-recommended', { entityId: 'refl-1', dag: null }),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).not.toContain('data-testid="triage-entity-link"')
  })

  // Regression coverage: the link decision must be driven by hasResolvableTask
  // (dag !== null), not by a per-kind allowlist. A kind-only check either
  // dead-links non-task rows of task-failure kinds (signature-storm,
  // gate-broken) or denies the link to real task rows of kinds it doesn't
  // enumerate (gate-broken carries a task id on SOME rows and a gate slug on
  // others — a single kind can't be classified either way).
  it('signature-storm rows (entityId is a signature slug, no dag) keep plain text', () => {
    mockItems.mockReturnValue([
      makeItem('signature-storm', { entityId: 'signature-storm:unknown', dag: null }),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).not.toContain('data-testid="triage-entity-link"')
    expect(html).toContain('signature-storm:unknown')
  })

  it('gate-broken rows with a gate-slug entityId (no dag) keep plain text', () => {
    mockItems.mockReturnValue([
      makeItem('gate-broken', { entityId: 'verify/typecheck', dag: null }),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).not.toContain('data-testid="triage-entity-link"')
    expect(html).toContain('verify/typecheck')
  })

  it('gate-broken rows with a real task id AND a populated dag still link', () => {
    mockItems.mockReturnValue([makeItem('gate-broken', { entityId: 'mars-84d1efb4' })])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('data-testid="triage-entity-link"')
    expect(html).toContain('href="#/task/mars-84d1efb4?from=triage"')
  })
})

// ---------------------------------------------------------------------------
// TriageRow — recovery-exhausted rows get carry-forward CLI hints, not
// Continue/Restart (mars continue refuses non-zero on these).
// ---------------------------------------------------------------------------

describe('TriageRow – recovery-exhausted rows surface carry-forward options', () => {
  beforeEach(() => {
    // The daemon decides this and sends a boolean. This fixture used to set
    // `failureReasonCode: 'recovery_exhausted:…'` — a shape production never
    // produces, because the prefix is written onto `failure_reason` and
    // `failureReasonCode` mirrors the different `failure_reason_code` column.
    // The page's own prefix test therefore never fired on a real row: the one
    // row whose branch holds salvageable commits was showing Restart.
    mockItems.mockReturnValue([
      makeItem('failed', {
        entityId: 'mars-abc123',
        recoveryExhausted: true,
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

  it('ignores a recovery_exhausted-looking failureReasonCode — the daemon decides', () => {
    // Guards against re-deriving the verdict client-side from the wrong column.
    mockItems.mockReturnValue([
      makeItem('failed', {
        entityId: 'mars-abc123',
        failureReasonCode: 'recovery_exhausted:verify/unclassified',
        recoveryExhausted: false,
      }),
    ])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-recovery-exhausted"]')).toBeNull()
    expect(container.querySelector('[data-testid="triage-continue"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Entity grouping — one task that derived several conditions gets ONE card
// with ONE verb set, so two rows can never give contradictory advice.
// ---------------------------------------------------------------------------

describe('TriagePage – several conditions for one task collapse to one card', () => {
  beforeEach(() => {
    // The live queue state this fixes: mars-6340b827 held three rows at once.
    // Its branch carries a coder salvage checkpoint, so the Restart the
    // `recovery-abandoned` row offered would have discarded real work — the
    // exact thing the `failed` row's carry-forward panel warns against.
    mockItems.mockReturnValue([
      makeItem('failed', {
        id: 'bc0e4764',
        entityId: 'mars-6340b827',
        recoveryExhausted: true,
      }),
      makeItem('recovery-abandoned', { id: '59a092fc', entityId: 'mars-6340b827' }),
      makeItem('gate-broken', { id: 'a1b64b91', entityId: 'mars-6340b827' }),
    ])
  })

  it('offers no Restart button anywhere on the page', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).toBeNull()
  })

  it('offers no Continue button anywhere on the page', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).toBeNull()
  })

  it('shows the carry-forward panel exactly once', () => {
    const { container } = renderPage()
    const panels = container.querySelectorAll('[data-testid="triage-recovery-exhausted"]')
    expect(panels).toHaveLength(1)
    expect(panels[0]?.textContent).toContain('mars remerge mars-6340b827')
  })

  it('keeps the collapsed conditions visible as read-only badges', () => {
    const { container } = renderPage()
    const badges = container.querySelector('[data-testid="triage-entity-badges"]')
    expect(badges).not.toBeNull()
    expect(
      container.querySelector('[data-testid="triage-entity-badge-recovery-abandoned"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="triage-entity-badge-gate-broken"]'),
    ).not.toBeNull()
  })

  it('counts the task as one subject in the header, not three', () => {
    const { container } = renderPage()
    expect(container.querySelector('[aria-label="1 item needs attention"]')).not.toBeNull()
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
    expect(mockStartThreadForQueueItem).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/chat?thread=alert-thread-id')
  })

  it('non-task-failure row: opens the row-keyed thread with a seeded opener', async () => {
    mockItems.mockReturnValue([
      makeItem('stale-worktree', { entityId: 'task-stale', humanSummary: 'Deploy step broke' }),
    ])
    mockStartThreadForQueueItem.mockResolvedValueOnce({ id: 'new-thread-id' })
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(mockStartThreadFromAlert).not.toHaveBeenCalled()
    // Keyed on the row id (so a second click reuses the thread) and carrying a
    // non-empty seed message.
    const [itemId, title, seed] = mockStartThreadForQueueItem.mock.calls[0] as string[]
    expect(itemId).toBeTruthy()
    expect(title).toBe('Deploy step broke')
    expect(seed).toContain('Deploy step broke')
    expect(window.location.hash).toBe('#/chat?thread=new-thread-id')
  })

  it('preserves the focused project id in the navigation hash', async () => {
    mockFocusedProjectId.mockReturnValue('proj-1')
    mockItems.mockReturnValue([makeItem('stale-worktree')])
    mockStartThreadForQueueItem.mockResolvedValueOnce({ id: 'new-thread-id' })
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(mockStartThreadForQueueItem).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 'proj-1',
    )
    expect(window.location.hash).toBe('#/chat?thread=new-thread-id&project=proj-1')
  })

  it('shows error feedback when thread resolution fails', async () => {
    mockItems.mockReturnValue([makeItem('stale-worktree')])
    mockStartThreadForQueueItem.mockRejectedValueOnce(new Error('Daemon unreachable'))
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const errorEl = container.querySelector('[data-testid="triage-error"]')
    expect(errorEl).not.toBeNull()
    expect(errorEl?.textContent).toContain('Daemon unreachable')
  })

  // -------------------------------------------------------------------------
  // 'failed' kind — the real action-queue condition kind (CLAUDE.md/ADR-0057).
  // Regression coverage for the bug: clicking Chat → on a failed row landed on
  // Main thread with no thread= param because resolveThreadForItem only
  // special-cased the never-emitted 'arc-failed' string. It must dedup via the
  // Alert-backed startThreadFromAlert, keyed by the arc's origin id.
  // -------------------------------------------------------------------------

  it('failed row (origin task): calls startThreadFromAlert with entityId, produces a non-empty thread=', async () => {
    mockItems.mockReturnValue([makeItem('failed', { entityId: 'mars-origin1', fixForTaskId: null })])
    mockStartThreadFromAlert.mockResolvedValueOnce({ threadId: 'origin-thread-id' })
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(mockStartThreadFromAlert).toHaveBeenCalledWith('mars-origin1')
    expect(mockStartThreadForQueueItem).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/chat?thread=origin-thread-id')
  })

  it('failed row (recovery/fix task): calls startThreadFromAlert with fixForTaskId, not entityId', async () => {
    // Reproduces the reported row: "Recovery task dropped [task mars-bff7e039]" —
    // entityId is the recovery task's own id; fixForTaskId is the arc's origin.
    mockItems.mockReturnValue([
      makeItem('failed', { entityId: 'mars-bff7e039', fixForTaskId: 'mars-origin1' }),
    ])
    mockStartThreadFromAlert.mockResolvedValueOnce({ threadId: 'origin-thread-id' })
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-chat"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    expect(mockStartThreadFromAlert).toHaveBeenCalledWith('mars-origin1')
    expect(mockStartThreadForQueueItem).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/chat?thread=origin-thread-id')
  })

  it('failed row: shows error feedback when the Alert-backed thread lookup fails', async () => {
    mockItems.mockReturnValue([makeItem('failed')])
    mockStartThreadFromAlert.mockRejectedValueOnce(new Error('Daemon unreachable'))
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
// Loading state — the first fetch in flight must render as "loading", never
// as "All quiet". Before this, an empty `items` array during the initial
// request was indistinguishable from a genuinely settled empty queue.
// ---------------------------------------------------------------------------

describe('TriagePage – first fetch still pending', () => {
  beforeEach(() => {
    mockItems.mockReturnValue([])
    mockQueueError.mockReturnValue(null)
    mockQueuePending.mockReturnValue(true)
  })

  it('renders the loading state, not "All quiet"', () => {
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-loading"]')).not.toBeNull()
    expect(container.textContent).not.toContain('All quiet')
  })

  it('yields to the error card once the fetch settles with an error', () => {
    mockQueuePending.mockReturnValue(false)
    mockQueueError.mockReturnValue(new Error('Cannot reach daemon'))
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-loading"]')).toBeNull()
    expect(container.querySelector('[data-testid="triage-feed-error-action-queue"]')).not.toBeNull()
  })

  it('yields to rendered rows once items arrive, even if isPending lags', () => {
    // Belt-and-suspenders: real items in hand must win over a stale pending
    // flag rather than hiding already-fetched content behind a spinner.
    mockItems.mockReturnValue([makeItem('failed')])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-loading"]')).toBeNull()
    expect(container.querySelector('[data-testid="triage-continue"]')).not.toBeNull()
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

// ---------------------------------------------------------------------------
// TriageRow — condition-kind vs decision-kind visibility after verb success
//
// Condition kinds (baseline-broken, failed, stale-queued, …) are derived on
// read from live system state — no stored row is closed by the mutation. The
// row MUST NOT be hidden optimistically; it must stay rendered and disappear
// only when the refetched feed no longer includes it.
//
// Decision kinds (gate-enrichment, awaiting-human, …) carry a stored row that
// is closed atomically by the mutation. Those rows MAY be hidden immediately.
// ---------------------------------------------------------------------------

describe('TriageRow – condition-kind verb success: row stays rendered', () => {
  it('baseline-broken: row stays rendered when item is still in the refetched feed', async () => {
    // baseline-broken is a condition kind — derived on read, never stored.
    // Clicking "Resume dispatch" does NOT close any stored row, so the row must
    // remain visible until the refetched feed confirms the condition cleared.
    // mockItems stays unchanged (simulating "condition still holds after verb").
    mockItems.mockReturnValue([
      makeItem('baseline-broken', {
        verbs: [{ op: 'resume-dispatch', label: 'Resume dispatch', style: 'primary' }],
      }),
    ])
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-verb-resume-dispatch"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    // Row must still be present — condition still holds in the refetched feed.
    // `resolved` was never set to true (condition kind), so `if (resolved) return null`
    // did not fire and the row is still in the DOM.
    expect(container.querySelector('[data-testid="triage-verb-resume-dispatch"]')).not.toBeNull()
  })

  it('failed kind: row stays rendered after a verb (same condition-kind guarantee)', async () => {
    // 'failed' is also a condition kind. Continue already had this property
    // (invokeAction resolved but the row stayed) — this test makes the
    // condition-kind contract explicit and guards it against regression.
    mockItems.mockReturnValue([makeItem('failed')])
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-continue"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    // Row still present — 'failed' is a condition kind.
    expect(container.querySelector('[data-testid="triage-continue"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TriageRow — §7 card hierarchy: operatorGoal → title subhead → Output disclosure
// ---------------------------------------------------------------------------

describe('TriageRow – operatorGoal headline hierarchy', () => {
  it('renders operatorGoal as the primary headline when present', () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        operatorGoal: 'Remove AlertCard injection from chat transcript',
        title: 'A verification check did not pass',
      }),
    ])
    const { container } = renderPage()
    const goalEl = container.querySelector('[data-testid="triage-goal"]')
    expect(goalEl).not.toBeNull()
    expect(goalEl?.textContent).toContain('Remove AlertCard injection from chat transcript')
  })

  it('renders item.title as the subhead when operatorGoal is present', () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        operatorGoal: 'Remove AlertCard injection from chat transcript',
        title: 'A verification check did not pass',
      }),
    ])
    const { container } = renderPage()
    const subheadEl = container.querySelector('[data-testid="triage-title-subhead"]')
    expect(subheadEl).not.toBeNull()
    expect(subheadEl?.textContent).toBe('A verification check did not pass')
  })

  it('renders raw error excerpt inside collapsed Output disclosure', () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        operatorGoal: 'Remove AlertCard injection from chat transcript',
        title: 'A verification check did not pass',
        humanDetail: { errorExcerpt: 'error TS2345: Argument of type string' },
      }),
    ])
    const { container } = renderPage()
    const disclosure = container.querySelector('[data-testid="triage-output-disclosure"]')
    expect(disclosure).not.toBeNull()
    // collapsed by default — the <details> element has no `open` attribute
    expect((disclosure as HTMLDetailsElement).open).toBe(false)
    // content is present inside the details element even when closed
    expect(disclosure?.textContent).toContain('error TS2345: Argument of type string')
  })

  it('renders rawError inside Output disclosure when errorExcerpt is absent', () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        operatorGoal: 'Fix type error in provider',
        title: 'A verification check did not pass',
        humanDetail: { rawError: 'Type string is not assignable to type number' },
      }),
    ])
    const { container } = renderPage()
    const disclosure = container.querySelector('[data-testid="triage-output-disclosure"]')
    expect(disclosure).not.toBeNull()
    expect(disclosure?.textContent).toContain('Type string is not assignable to type number')
  })

  it('omits Output disclosure when humanDetail has no errorExcerpt or rawError', () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        operatorGoal: 'Fix type error in provider',
        title: 'A verification check did not pass',
        humanDetail: { branch: 'task/mars-abc' },
      }),
    ])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-output-disclosure"]')).toBeNull()
  })

  it('falls back to humanSummary as sole headline when operatorGoal is absent', () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        operatorGoal: null,
        humanSummary: 'Summary for failed',
      }),
    ])
    const { container } = renderPage()
    // No goal element — fallback headline rendered as an unlabelled <p>
    expect(container.querySelector('[data-testid="triage-goal"]')).toBeNull()
    expect(container.querySelector('[data-testid="triage-title-subhead"]')).toBeNull()
    expect(container.textContent).toContain('Summary for failed')
  })

  it('falls back to item.title as sole headline when operatorGoal and humanSummary are both absent', () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        operatorGoal: null,
        humanSummary: undefined,
        title: 'Title for failed',
      }),
    ])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-goal"]')).toBeNull()
    expect(container.textContent).toContain('Title for failed')
  })

  it('humanSummary renders as tertiary line when operatorGoal is present', () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        operatorGoal: 'Remove AlertCard injection from chat transcript',
        title: 'A verification check did not pass',
        humanSummary: 'Summary for failed',
      }),
    ])
    const { container } = renderPage()
    // All three layers visible simultaneously
    expect(container.querySelector('[data-testid="triage-goal"]')?.textContent)
      .toContain('Remove AlertCard injection from chat transcript')
    expect(container.querySelector('[data-testid="triage-title-subhead"]')?.textContent)
      .toBe('A verification check did not pass')
    expect(container.textContent).toContain('Summary for failed')
  })
})

describe('TriageRow – operator-decision kind: row hides optimistically on verb success', () => {
  it('gate-enrichment decision button: row disappears immediately on success', async () => {
    // gate-enrichment is a decision kind — its stored row is closed atomically
    // with the mutation, so the client can safely hide it without waiting for a
    // refetch. This is the correct, intended behaviour for all decision kinds.
    mockItems.mockReturnValue([
      makeItem('gate-enrichment', {
        decisions: [{ label: 'Approve', endpoint: '/api/gate/approve', payload: {} }],
      }),
    ])
    mockPostDecision.mockResolvedValueOnce(new Response(null, { status: 200 }))
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-decision-Approve"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    // Row is gone — decision kind, row closed atomically with the mutation.
    expect(container.querySelector('[data-testid="triage-decision-Approve"]')).toBeNull()
  })
})
