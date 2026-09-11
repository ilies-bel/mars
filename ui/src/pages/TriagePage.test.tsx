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
// useCounts is the single source of truth for the "needs you" number (see the
// Numbers section of ui/README.md). Mocked here so the header badge does not
// depend on a live query.
let mockNeedsYou = 1
vi.mock('@/entities/counts/useCounts', () => ({
  useCounts: () => ({
    needsYou: mockNeedsYou,
    running: 0, verifying: 0, merging: 0,
    queued: 0, blocked: 0, failed: 0, doneToday: 0,
    proposals: { draft: 0, total: 0 },
    known: true,
  }),
}))

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

  it('labels the link "Review proposals" with a lucide arrow', () => {
    mockItems.mockReturnValue([
      makeItem('draft-proposal', { kind: 'draft-proposal' } as Partial<ActionQueueItem>),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('Review proposals')
    expect(html).toContain('lucide-arrow-right')
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

  it('renders no Restart button when the server sent no restart verb', () => {
    // The row has no hardcoded Restart. With `verbs: []` there is nothing to
    // render — which is correct: the server withholds restart on arcs where
    // the CLI would refuse it.
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-restart"]')).toBeNull()
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
          { op: 'restart', label: 'Restart', style: 'destructive' },
          { op: 'purge', label: 'Discard task', style: 'destructive' },
          { op: 'dismiss', label: 'Dismiss', style: 'default' },
        ],
      }),
    ])
  })

  it('renders the daemon restart verb', () => {
    // It used to be dropped, because the row drew its own Restart unconditionally
    // and the two would have sat side by side. The row no longer draws one, so
    // the server's verb is the only Restart — and the only one is the right
    // number, because the server is the only thing that knows whether restart
    // is the correct verb for this arc.
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-restart"]')).not.toBeNull()
  })

  it('keeps the confirm gate on the server restart verb', async () => {
    // The guard was the point of the hardcoded control; it must survive the
    // move. Clicking arms the confirmation rather than firing.
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-verb-restart"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    expect(mockInvokeAction).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="triage-restart-confirm"]')).not.toBeNull()
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
        verbs: [{ op: 'restart', label: 'Restart daemon', style: 'destructive' }],
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
// TriageRow — decision button style field
// ---------------------------------------------------------------------------

describe('TriageRow – decision button style field', () => {
  it('applies destructive styling when style is "destructive"', () => {
    mockItems.mockReturnValue([
      makeItem('gate-enrichment', {
        decisions: [
          {
            label: 'Retire',
            endpoint: '/api/gate/retire',
            payload: {},
            style: 'destructive',
          },
        ],
      }),
    ])
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-decision-Retire"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.className).toContain('text-error')
  })

  // The ladder allows exactly ONE filled button per row, so a lone decision is
  // the CTA whether or not the daemon marks it. These two cases are therefore
  // only observable on a row with several decisions — asserting which one wins
  // the slot, rather than which Tailwind tokens it happens to carry.
  it('promotes the decision the daemon nominates, not merely the first one', () => {
    mockItems.mockReturnValue([
      makeItem('gate-enrichment', {
        decisions: [
          { label: 'Skip', endpoint: '/api/gate/skip', payload: {} },
          {
            label: 'Approve',
            endpoint: '/api/gate/approve',
            payload: {},
            style: 'primary',
          },
        ],
      }),
    ])
    const { container } = renderPage()
    const approve = container.querySelector(
      '[data-testid="triage-decision-Approve"]',
    ) as HTMLButtonElement
    const skip = container.querySelector(
      '[data-testid="triage-decision-Skip"]',
    ) as HTMLButtonElement
    expect(approve).not.toBeNull()
    expect(skip).not.toBeNull()
    // The nominee carries the filled treatment; the earlier decision does not.
    expect(approve.className).toContain('bg-highlight')
    expect(skip.className).not.toContain('bg-highlight')
  })

  it('falls back to the first non-destructive decision when none is nominated', () => {
    mockItems.mockReturnValue([
      makeItem('gate-enrichment', {
        decisions: [
          { label: 'Approve', endpoint: '/api/gate/approve', payload: {} },
          { label: 'Skip', endpoint: '/api/gate/skip', payload: {} },
        ],
      }),
    ])
    const { container } = renderPage()
    const approve = container.querySelector(
      '[data-testid="triage-decision-Approve"]',
    ) as HTMLButtonElement
    const skip = container.querySelector(
      '[data-testid="triage-decision-Skip"]',
    ) as HTMLButtonElement
    expect(approve.className).toContain('bg-highlight')
    expect(skip.className).not.toContain('bg-highlight')
  })

  it('never lets a destructive decision take the primary slot', () => {
    mockItems.mockReturnValue([
      makeItem('gate-enrichment', {
        decisions: [
          {
            label: 'Purge',
            endpoint: '/api/gate/purge',
            payload: {},
            style: 'primary',
          },
          { label: 'Skip', endpoint: '/api/gate/skip', payload: {} },
        ],
      }),
    ])
    const { container } = renderPage()
    const purge = container.querySelector(
      '[data-testid="triage-decision-Purge"]',
    ) as HTMLButtonElement
    const skip = container.querySelector(
      '[data-testid="triage-decision-Skip"]',
    ) as HTMLButtonElement
    // Nominated by the daemon, but destructive by label — the safe path keeps
    // the filled slot and Purge stays quiet.
    expect(purge.className).not.toContain('bg-highlight')
    expect(purge.className).toContain('text-error')
    expect(skip.className).toContain('bg-highlight')
  })
})

// ---------------------------------------------------------------------------
// TriageRow — mutations fired on click
// ---------------------------------------------------------------------------

describe('TriageRow – Continue/Restart buttons fire invokeAction', () => {
  beforeEach(() => {
    // Restart reaches the row as a server verb now, not a hardcoded control.
    mockItems.mockReturnValue([
      makeItem('failed', {
        verbs: [{ op: 'restart', label: 'Restart', style: 'destructive' }],
      }),
    ])
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
    // Restart now arrives as a server verb rather than a hardcoded control;
    // the confirm gate is what must not change.
    mockItems.mockReturnValue([
      makeItem('failed', {
        verbs: [{ op: 'restart', label: 'Restart', style: 'destructive' }],
      }),
    ])
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-verb-restart"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    expect(mockInvokeAction).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="triage-restart-confirm"]')).not.toBeNull()
  })

  it('confirm text names the task, and says nothing is lost when there is no branch', async () => {
    // The default fixture carries no branch, which means the task never got
    // one — it died before setup finished. Claiming a restart would lose
    // commits there contradicts the task drawer, which reports no branch on
    // record for the same task.
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-verb-restart"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const confirmEl = container.querySelector('[data-testid="triage-restart-confirm"]')
    expect(confirmEl?.textContent).toContain('task-failed')
    expect(confirmEl?.textContent).toMatch(/nothing on disk is lost/i)
    expect(confirmEl?.textContent).not.toMatch(/losing any commits/i)
  })

  it('confirm text includes the branch when humanDetail.branch is present', async () => {
    mockItems.mockReturnValue([
      makeItem('failed', {
        humanDetail: { branch: 'task/mars-abc123' },
        verbs: [{ op: 'restart', label: 'Restart', style: 'destructive' }],
      }),
    ])
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-verb-restart"]') as HTMLButtonElement
    await act(async () => {
      btn.click()
    })
    const confirmEl = container.querySelector('[data-testid="triage-restart-confirm"]')
    expect(confirmEl?.textContent).toContain('task/mars-abc123')
  })

  it('clicking "Yes, discard & restart" in the confirm step calls invokeAction("restart", entityId)', async () => {
    const { container } = renderPage()
    const restartBtn = container.querySelector('[data-testid="triage-verb-restart"]') as HTMLButtonElement
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
    const restartBtn = container.querySelector('[data-testid="triage-verb-restart"]') as HTMLButtonElement
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
    expect(container.querySelector('[data-testid="triage-verb-restart"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// TriageRow — task id is reachable (evidence before a destroy-or-resume call)
// ---------------------------------------------------------------------------

describe('TriageRow – task id is a link to the task detail drawer', () => {
  it('makes the headline the link into #/task/<id> (real task id, non-null dag)', () => {
    // The route into the task used to be a separate control labelled "→ task"
    // sitting above the actions; the headline itself was inert. Clicking the
    // name of a thing is how you open the thing, so the headline carries it.
    mockItems.mockReturnValue([makeItem('failed', { entityId: 'mars-bff7e039' })])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('href="#/task/mars-bff7e039?from=triage"')
    expect(html).not.toContain('data-testid="triage-entity-link"')
    expect(html).not.toContain('→ task')
  })

  it('non-task-backed kinds (reflect-recommended) keep the entity id as plain text', () => {
    mockItems.mockReturnValue([
      makeItem('reflect-recommended', { entityId: 'refl-1', dag: null }),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    // Asserting the absence of the retired "→ task" testid would pass
    // vacuously now. What must hold is that the headline is NOT a link: there
    // is no task behind this row to open.
    expect(html).not.toContain('href="#/task/refl-1')
    expect(html).toContain('<p')
  })

  // Regression coverage: the link decision must be driven by hasResolvableTask
  // (dag !== null), not by a per-kind allowlist. A kind-only check either
  // dead-links non-task rows of task-failure kinds (signature-storm,
  // gate-broken) or denies the link to real task rows of kinds it doesn't
  // enumerate (gate-broken carries a task id on SOME rows and a gate slug on
  // others — a single kind can't be classified either way).
  //
  // DEC-18 fix: non-task-backed rows must render NO entity line at all.
  // The kind badge already names the condition in plain language; repeating
  // the slug (e.g. "signature-storm:unknown", "verify/typecheck") as plain
  // text is machine jargon on the card face. The entity id is suppressed, not
  // demoted to plain text.
  it('signature-storm rows (entityId is a signature slug, no dag) render no entity line', () => {
    mockItems.mockReturnValue([
      makeItem('signature-storm', { entityId: 'signature-storm:unknown', dag: null }),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    // No task behind the row means no link on the headline.
    expect(html).not.toContain('href="#/task/signature-storm')
    // The slug must not appear anywhere on the card face (DEC-18)
    expect(html).not.toContain('signature-storm:unknown')
  })

  it('gate-broken rows with a gate-slug entityId (no dag) render no entity line', () => {
    mockItems.mockReturnValue([
      makeItem('gate-broken', { entityId: 'verify/typecheck', dag: null }),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).not.toContain('data-testid="triage-entity-link"')
    // The slug must not appear anywhere on the card face (DEC-18)
    expect(html).not.toContain('verify/typecheck')
  })

  it('gate-broken rows with a real task id AND a populated dag still link', () => {
    mockItems.mockReturnValue([makeItem('gate-broken', { entityId: 'mars-84d1efb4' })])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('href="#/task/mars-84d1efb4?from=triage"')
  })
})

// ---------------------------------------------------------------------------
// TriageRow — recovery-exhausted rows: server verbs are the single source of
// truth. The client must NOT infer Remerge/Supersede from recoveryExhausted.
// ---------------------------------------------------------------------------

describe('TriageRow – recovery-exhausted rows render only server-sent verbs', () => {
  it('has no Continue button when exhausted', () => {
    mockItems.mockReturnValue([
      makeItem('failed', { entityId: 'mars-abc123', recoveryExhausted: true }),
    ])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).toBeNull()
  })

  it('has no Restart button in the primary row when exhausted', () => {
    mockItems.mockReturnValue([
      makeItem('failed', { entityId: 'mars-abc123', recoveryExhausted: true }),
    ])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).toBeNull()
  })

  it('never renders a client-inferred triage-recovery-exhausted panel', () => {
    // The panel is deleted; the server verb loop is the only source of buttons.
    mockItems.mockReturnValue([
      makeItem('failed', { entityId: 'mars-abc123', recoveryExhausted: true }),
    ])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-recovery-exhausted"]')).toBeNull()
  })

  it('row with verbs=[restart,purge] renders no Remerge or Supersede button', () => {
    // The branch holds nothing — the server sends only restart+purge. The
    // client must NOT infer remerge/supersede from recoveryExhausted alone.
    // Note: restart verbs are filtered for task-recovery kinds (to avoid
    // duplicating the guarded-confirm restart button), so only purge renders.
    mockItems.mockReturnValue([
      makeItem('failed', {
        entityId: 'mars-874b2a81',
        recoveryExhausted: true,
        verbs: [
          { op: 'restart', label: 'Restart from scratch', style: 'destructive' },
          { op: 'purge', label: 'Discard task', style: 'destructive' },
        ],
      }),
    ])
    const { container } = renderPage()
    // Absence assertion — the core regression guard.
    expect(container.querySelector('[data-testid="triage-remerge"]')).toBeNull()
    expect(container.querySelector('[data-testid="triage-supersede"]')).toBeNull()
    expect(container.querySelector('[data-testid="triage-verb-remerge"]')).toBeNull()
    expect(container.querySelector('[data-testid="triage-verb-supersede"]')).toBeNull()
    // Purge verb renders (restart is filtered for task-recovery rows to avoid
    // a duplicate unguarded button alongside the confirm-gated one).
    expect(container.querySelector('[data-testid="triage-verb-purge"]')).not.toBeNull()
  })

  it('row with verbs=[remerge] renders the Remerge button via the verb loop', () => {
    // Real commits ahead — the server sends remerge. The verb loop should render it.
    mockItems.mockReturnValue([
      makeItem('failed', {
        entityId: 'mars-abc123',
        recoveryExhausted: true,
        verbs: [
          { op: 'remerge', label: 'Remerge (3 commits)', style: 'primary' },
        ],
      }),
    ])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-remerge"]')).not.toBeNull()
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
    // No panel (it is deleted). Continue is still shown since recoveryExhausted=false.
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

  it('has no client-inferred carry-forward panel (server verbs are the source of truth)', () => {
    // The triage-recovery-exhausted panel is deleted. Verbs come from item.verbs.
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-recovery-exhausted"]')).toBeNull()
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

  it('arms a confirmation first — a daemon restart is not a one-click action', async () => {
    // This used to assert that one click dispatched. It did, and that was the
    // defect: a reviewer clicked "Restart (wipe & re-run)" on a Needs You card
    // expecting to READ a confirmation, and the task restarted with no dialog,
    // no toast and no undo. Every destructive verb passes the same gate now.
    const { container } = renderPage()
    const btn = container.querySelector('[data-testid="triage-verb-restart-daemon"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => {
      btn.click()
    })
    expect(mockInvokeAction).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="triage-restart-confirm"]')).not.toBeNull()
  })

  it('dispatches the process-level op once confirmed', async () => {
    const { container } = renderPage()
    await act(async () => {
      ;(container.querySelector('[data-testid="triage-verb-restart-daemon"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="triage-restart-confirm-yes"]') as HTMLButtonElement).click()
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
// TriageRow — Chat link carries the alert's identity in its href
// ---------------------------------------------------------------------------

describe('TriageRow – Chat link hrefs are scoped to each alert', () => {
  it('each Chat link carries the alert item id in the href', () => {
    mockItems.mockReturnValue([makeItem('stale-worktree', { id: 'item-alpha' })])
    const { container } = renderPage()
    const link = container.querySelector('[data-testid="triage-chat"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toContain('item=item-alpha')
  })

  it('two different alerts produce two different hrefs', () => {
    mockItems.mockReturnValue([
      makeItem('failed', { id: 'item-one', entityId: 'mars-1' }),
      makeItem('stale-worktree', { id: 'item-two', entityId: 'mars-2' }),
    ])
    const { container } = renderPage()
    const links = container.querySelectorAll('[data-testid="triage-chat"]') as NodeListOf<HTMLAnchorElement>
    expect(links.length).toBeGreaterThanOrEqual(2)
    const hrefs = Array.from(links).map((a) => a.getAttribute('href'))
    // Every href is unique
    expect(new Set(hrefs).size).toBe(hrefs.length)
    // Each carries its own item id
    expect(hrefs.some((h) => h?.includes('item=item-one'))).toBe(true)
    expect(hrefs.some((h) => h?.includes('item=item-two'))).toBe(true)
  })

  it('includes the focused project id in the href', () => {
    mockFocusedProjectId.mockReturnValue('proj-1')
    mockItems.mockReturnValue([makeItem('stale-worktree', { id: 'item-proj' })])
    const { container } = renderPage()
    const link = container.querySelector('[data-testid="triage-chat"]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('item=item-proj')
    expect(link.getAttribute('href')).toContain('project=proj-1')
  })

  it('failed (task-recovery) row renders the chat icon link, not a text link', () => {
    mockItems.mockReturnValue([makeItem('failed', { id: 'item-fail' })])
    const { container } = renderPage()
    const link = container.querySelector('[data-testid="triage-chat"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toContain('item=item-fail')
  })

  it('no Chat link fires thread resolution APIs on render', () => {
    mockItems.mockReturnValue([
      makeItem('failed', { id: 'f1' }),
      makeItem('stale-worktree', { id: 's1' }),
    ])
    renderPage()
    expect(mockStartThreadFromAlert).not.toHaveBeenCalled()
    expect(mockStartThreadForQueueItem).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// KIND_LABEL — kind chip shows a humanised label, never a raw machine slug
//
// DEC-18: a raw hyphenated kind slug on the face of the operator's first read
// falsifies the vision claim. The three kinds called out by the task report
// (daemon-died, verify-uncovered, gate-enrichment-stale) were absent from the
// previous KIND_LABEL map; the map is now exhaustive and a missing label is a
// compile error. The humanising fallback (`replace(/-/g, ' ')`) is kept as
// defence in depth for kinds arriving from the daemon after a build.
// ---------------------------------------------------------------------------

describe('TriagePage – kind chip never renders a raw machine slug', () => {
  it('daemon-died renders its mapped label on the chip face', () => {
    mockItems.mockReturnValue([makeItem('daemon-died')])
    const html = renderToStaticMarkup(<TriagePage />)
    // "engine crashed", not "daemon died": the card body underneath calls it
    // the background engine, and "daemon" is an implementation word that
    // appears nowhere else in the copy an operator reads.
    expect(html).toContain('engine crashed')
    expect(html).not.toContain('daemon died')
    // Raw hyphenated slug must not appear on the card face
    expect(html).not.toMatch(/>\s*daemon-died\s*</)
  })

  it('names the background engine the same way the chip and the body do', () => {
    // A chip reading "daemon drift" over a body reading "an update is available
    // for the background engine" makes the reader work out that the two nouns
    // are one thing. The label and the copy have to agree.
    mockItems.mockReturnValue([makeItem('daemon-code-drift')])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('engine update')
    expect(html).not.toContain('daemon drift')
  })

  it('names a repeat-failure wave in words, not in the abbreviation', () => {
    mockItems.mockReturnValue([makeItem('signature-wave')])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('shared cause')
    expect(html).not.toContain('sig wave')
  })

  it('verify-uncovered renders its mapped label on the chip face', () => {
    mockItems.mockReturnValue([makeItem('verify-uncovered')])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('uncovered')
    expect(html).not.toMatch(/>\s*verify-uncovered\s*</)
  })

  it('gate-enrichment-stale renders its mapped label on the chip face', () => {
    mockItems.mockReturnValue([makeItem('gate-enrichment-stale')])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('stale enrichment')
    expect(html).not.toMatch(/>\s*gate-enrichment-stale\s*</)
  })

  it('a kind unknown at build time is humanised (hyphens → spaces) rather than emitted raw', () => {
    // Simulates a kind the daemon shipped after the last build cut — the
    // defence-in-depth fallback must produce readable text, not a slug.
    // Override title/entityId so the kind slug does not bleed into other
    // fields; we are only testing the chip label path.
    // The cast is intentional: we are probing the runtime path, not the
    // compile-time exhaustiveness check.
    mockItems.mockReturnValue([
      makeItem('future-unknown-kind' as unknown as string, {
        id: 'unknown-kind-item',
        entityId: 'task-abc123',
        title: 'A test item',
        humanSummary: 'Test summary',
      }),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('future unknown kind')
    // The raw slug must not reach the chip face; it must not appear at all
    // since we scrubbed it from every other field above.
    expect(html).not.toContain('future-unknown-kind')
  })

  it('badge kinds (extra conditions on entity-grouped cards) are also humanised', () => {
    // Tests the third fallback site (extraBadges) in TriageRow.
    mockItems.mockReturnValue([
      makeItem('failed', {
        id: 'primary-row',
        entityId: 'mars-abc',
        recoveryExhausted: false,
      }),
      makeItem('gate-broken', {
        id: 'badge-row',
        entityId: 'mars-abc',
      }),
    ])
    const html = renderToStaticMarkup(<TriagePage />)
    // gate-broken → 'gate broken' (from the map); must not appear raw on the badge
    expect(html).toContain('gate broken')
    expect(html).not.toMatch(/>\s*gate-broken\s*</)
  })
})

// ---------------------------------------------------------------------------
// Verb-status correctness: no card offers a verb refused for its task status
// ---------------------------------------------------------------------------

describe('TriageRow – phantom-merge renders server-sent verbs (no client panel)', () => {
  // The server recipe now sends verbs: [remerge (primary), copy-supersede].
  // The client panel is deleted; the verb loop is the only source of buttons.
  const phantomMergeVerbs = [
    { op: 'remerge', label: 'Remerge — branch still has commits', style: 'primary' as const },
    { op: 'copy', label: 'Supersede — run from checkpoint', style: 'default' as const, hint: 'mars task add --supersede task-phantom-merge' },
  ]

  it('phantom-merge has no Continue button', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge', { verbs: phantomMergeVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).toBeNull()
  })

  it('phantom-merge has no Restart button (not a task-recovery kind)', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge', { verbs: phantomMergeVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).toBeNull()
  })

  it('phantom-merge has no client-inferred carry-forward panel', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge', { verbs: phantomMergeVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-phantom-merge-panel"]')).toBeNull()
  })

  it('phantom-merge renders Remerge verb from server verbs', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge', { verbs: phantomMergeVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-remerge"]')).not.toBeNull()
  })

  it('phantom-merge renders copy-supersede verb from server verbs', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge', { verbs: phantomMergeVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-copy"]')).not.toBeNull()
  })
})

describe('TriageRow – phantom-merge-unknown renders server-sent verbs (no client panel)', () => {
  // The server recipe sends only copy-supersede (no branch to remerge).
  const phantomUnknownVerbs = [
    { op: 'copy', label: 'Supersede — run from checkpoint', style: 'default' as const, hint: 'mars task add --supersede task-phantom-merge-unknown' },
  ]

  it('phantom-merge-unknown has no Continue button', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge-unknown', { verbs: phantomUnknownVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-continue"]')).toBeNull()
  })

  it('phantom-merge-unknown has no Restart button', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge-unknown', { verbs: phantomUnknownVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).toBeNull()
  })

  it('phantom-merge-unknown has no client-inferred carry-forward panel', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge-unknown', { verbs: phantomUnknownVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-phantom-merge-panel"]')).toBeNull()
  })

  it('phantom-merge-unknown has no Remerge button (no surviving branch — server decides)', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge-unknown', { verbs: phantomUnknownVerbs })])
    const { container } = renderPage()
    // Server sends no remerge verb; absence assertion guards against client-side inference.
    expect(container.querySelector('[data-testid="triage-verb-remerge"]')).toBeNull()
    expect(container.querySelector('[data-testid="triage-remerge"]')).toBeNull()
  })

  it('phantom-merge-unknown shows the Supersede copy verb', () => {
    mockItems.mockReturnValue([makeItem('phantom-merge-unknown', { verbs: phantomUnknownVerbs })])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-verb-copy"]')).not.toBeNull()
  })
})

describe('TriageRow – done-with-unmerged-commits does NOT offer Continue (task is done)', () => {
  it('done-with-unmerged-commits has no Continue button', () => {
    mockItems.mockReturnValue([makeItem('done-with-unmerged-commits')])
    const { container } = renderPage()
    // mars continue is refused for non-failed tasks. The recipe's restart verb
    // (Re-attempt merge) is the correct CTA and is rendered via mainVerbs.
    expect(container.querySelector('[data-testid="triage-continue"]')).toBeNull()
  })

  it('done-with-unmerged-commits has no guarded Restart control (recipe provides one)', () => {
    mockItems.mockReturnValue([makeItem('done-with-unmerged-commits')])
    const { container } = renderPage()
    expect(container.querySelector('[data-testid="triage-restart"]')).toBeNull()
  })

  it('done-with-unmerged-commits renders the server Re-attempt merge verb', () => {
    mockItems.mockReturnValue([
      makeItem('done-with-unmerged-commits', {
        verbs: [{ op: 'restart', label: 'Re-attempt merge', style: 'primary' }],
      }),
    ])
    const { container } = renderPage()
    // The restart verb is NOT filtered for this kind (it is not in TASK_RECOVERY_KINDS)
    expect(container.querySelector('[data-testid="triage-verb-restart"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Toolbar controls have to say what they are
//
// The search field and the kind filter are the two controls a keyboard or
// screen-reader user reaches first on this page, and neither had an
// accessible name (WCAG 4.1.2, Level A). The input announced as "edit text,
// blank"; the select fell back to concatenating every option, so its name was
// "All kinds awaiting engine update proposal…".
// ---------------------------------------------------------------------------

describe('TriagePage – the toolbar controls are named', () => {
  it('names the search field, which a placeholder does not do', () => {
    // A placeholder is announced as a hint on some engines and not at all on
    // others, and it disappears the moment anything is typed.
    mockItems.mockReturnValue([makeItem('failed')])
    const html = renderToStaticMarkup(<TriagePage />)
    const input = html.slice(html.indexOf('data-testid="triage-search"') - 600)
    expect(input.slice(0, input.indexOf('data-testid="triage-search"'))).toContain(
      'aria-label="Search the queue"',
    )
  })

  it('names the kind filter, so it is not read as a list of its own options', () => {
    mockItems.mockReturnValue([makeItem('failed')])
    const html = renderToStaticMarkup(<TriagePage />)
    expect(html).toContain('aria-label="Filter by kind"')
  })
})
