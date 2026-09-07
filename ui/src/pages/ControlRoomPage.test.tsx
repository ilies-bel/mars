// @vitest-environment happy-dom
/**
 * Behaviour test for ControlRoomPage's NOW block dispatch indicator and
 * EngineSection (daemon-code-drift restart action).
 *
 * TopStripe's health dot already has dedicated coverage (TopStripe.test.tsx)
 * for "never show green 'live' while dispatch is paused". This page has its
 * own, separately-written copy of that same dot inside NowSection — it does
 * not delegate to TopStripe — so a regression there is invisible to the
 * TopStripe suite. This is literally the second symptom named in the bug
 * report ("Control Room's own NOW block, directly below the PAUSED lever,
 * also showed a green Live"), so it gets its own assertion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ControlRoomPage } from './ControlRoomPage'

// LeversSection queries fetchOperatorState directly via useQuery, and
// RulesSection queries fetchGlossary/fetchAdrs — none of those resolve
// synchronously, so they stay in their loading state during
// renderToStaticMarkup and never interfere with the NOW block assertions
// below. They're mocked here only so the real network functions are never
// invoked from a test.
const mockInvokeAction = vi.fn().mockResolvedValue(undefined)

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api')>()
  return {
    ...actual,
    fetchOperatorState: vi.fn(() => new Promise(() => {})),
    fetchGlossary: vi.fn(() => new Promise(() => {})),
    fetchAdrs: vi.fn(() => new Promise(() => {})),
    fetchVerifyGates: vi.fn(() => new Promise(() => {})),
    invokeAction: (...args: unknown[]) => mockInvokeAction(...args),
  }
})

const mockUseProgress = vi.fn()
vi.mock('@/hooks/useProgress', () => ({
  useProgress: (...args: unknown[]) => mockUseProgress(...args),
}))

vi.mock('@/hooks/useStatusCounts', () => ({
  useStatusCounts: () => ({
    running: 0,
    recovering: 0,
    needYou: 0,
    failed: 0,
    doneToday: 0,
    known: true,
  }),
}))

const mockUseActionQueue = vi.fn()
vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: (...args: unknown[]) => mockUseActionQueue(...args),
}))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProject: () => ({ focusedProjectId: null }),
}))

const mockUseDispatchState = vi.fn()
vi.mock('@/entities/operator/useDispatchState', () => ({
  useDispatchState: (...args: unknown[]) => mockUseDispatchState(...args),
  pauseReasonLabel: (state: { reason: string | null }) =>
    state.reason === 'storm' ? 'signature storm' : 'paused',
}))

// useStewardView — used by StewardHistorySection. Returns undefined data by
// default (no data yet), so the section renders just the ledger panel with no ratchet.
vi.mock('./useStewardView', () => ({
  useStewardView: () => ({ data: undefined, isLoading: false, error: null }),
}))

// StewardLedgerPanel — live component makes a fetch; stub it for unit tests.
vi.mock('@/widgets/StewardLedgerPanel', () => ({
  StewardLedgerPanel: () => <div data-testid="steward-ledger-panel-stub">Steward ledger</div>,
}))

// CapRatchet from StewardPage — stub so this test stays focused on ControlRoom
// behaviour, not StewardPage internals.
vi.mock('./StewardPage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./StewardPage')>()
  return {
    ...actual,
    CapRatchet: () => <div data-testid="cap-ratchet-stub">Cap ratchet</div>,
  }
})

/** Default empty progress state used by tests that don't care about engine drift. */
const emptyProgressState = () => ({
  tasks: [],
  byCluster: {
    Queued: [],
    'In progress': [],
    Blocked: [],
    Failed: [],
    Done: [],
  },
  aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 },
  proposals: [],
  error: null,
  connected: true,
})

const renderControlRoom = (preloadedGates?: import('@/shared/api').VerifyGate[]) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  if (preloadedGates !== undefined) {
    client.setQueryData(['verify-gates'], preloadedGates)
  }
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ControlRoomPage)),
  )
}

/** Render ControlRoomPage into the live DOM for interactive (click) tests. */
function renderInteractive(preloadedGates?: import('@/shared/api').VerifyGate[]): {
  container: HTMLElement
  root: ReturnType<typeof createRoot>
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  if (preloadedGates !== undefined) {
    client.setQueryData(['verify-gates'], preloadedGates)
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, createElement(ControlRoomPage)))
  })
  return { container, root }
}

describe('ControlRoomPage — Steward history section', () => {
  beforeEach(() => {
    mockUseDispatchState.mockReturnValue({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })
    mockUseActionQueue.mockReturnValue({ items: [], serverGroups: [], error: null, isPending: false })
    mockUseProgress.mockReturnValue(emptyProgressState())
  })

  it('renders the Steward history section', () => {
    const html = renderControlRoom()
    expect(html).toContain('data-testid="steward-history-section"')
  })

  it('renders the Steward ledger panel', () => {
    const html = renderControlRoom()
    expect(html).toContain('data-testid="steward-ledger-panel-stub"')
  })

  it('includes a link to the full Steward view', () => {
    const html = renderControlRoom()
    expect(html).toContain('href="#/steward"')
  })

  it('renders the "Steward history" section label', () => {
    const html = renderControlRoom()
    expect(html).toContain('Steward history')
  })
})

describe('ControlRoomPage – NOW block dispatch indicator', () => {
  beforeEach(() => {
    mockUseActionQueue.mockReturnValue({ items: [], serverGroups: [], error: null, isPending: false })
    mockUseProgress.mockReturnValue(emptyProgressState())
  })

  it('does not render the "Live" label when dispatch is paused', () => {
    mockUseDispatchState.mockReturnValue({
      paused: true,
      reason: 'storm',
      since: null,
      detail: null,
    })

    const html = renderControlRoom()

    expect(html).not.toContain('>Live<')
    expect(html).toContain('Paused')
    expect(html).toContain('signature storm')
  })

  it('renders the "Live" label when dispatch is running', () => {
    mockUseDispatchState.mockReturnValue({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })

    const html = renderControlRoom()

    expect(html).toContain('>Live<')
  })
})

describe('ControlRoomPage — Gates section', () => {
  beforeEach(() => {
    mockUseActionQueue.mockReturnValue({ items: [], serverGroups: [], error: null, isPending: false })
    mockUseProgress.mockReturnValue(emptyProgressState())
  })

  it('renders the Gates section with testid', () => {
    mockUseDispatchState.mockReturnValue({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })

    const html = renderControlRoom()
    expect(html).toContain('data-testid="gates-section"')
  })

  it('renders the "Gates" section label', () => {
    mockUseDispatchState.mockReturnValue({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })

    const html = renderControlRoom()
    // The section label is rendered as text in the page
    expect(html).toContain('Gates')
  })

  it('Gates section appears between Levers and Now in the DOM', () => {
    mockUseDispatchState.mockReturnValue({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })

    const html = renderControlRoom()

    // All three sections must be present
    expect(html).toContain('data-testid="gates-section"')
    expect(html).toContain('>Live<')

    // Gates must precede the Now section's Live indicator
    const gatesIdx = html.indexOf('data-testid="gates-section"')
    const liveIdx = html.indexOf('>Live<')
    expect(gatesIdx).toBeLessThan(liveIdx)
  })
})

describe('ControlRoomPage — Gates section run status', () => {
  beforeEach(() => {
    mockUseDispatchState.mockReturnValue({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })
    mockUseActionQueue.mockReturnValue({ items: [], serverGroups: [], error: null, isPending: false })
    mockUseProgress.mockReturnValue(emptyProgressState())
  })

  const makeGate = (overrides: Partial<import('@/shared/api').VerifyGate> = {}): import('@/shared/api').VerifyGate => ({
    id: 'gate-1',
    scope: '.',
    name: 'typecheck',
    cmd: 'npx',
    args: ['tsc', '--noEmit'],
    required: true,
    tier: 'task',
    source: 'human',
    createdAt: 1000,
    state: 'active',
    quarantinedAt: null,
    lastFailureAt: null,
    timeoutMin: null,
    lastPassAt: null,
    ...overrides,
  })

  it('renders passing status badge when lastPassAt is more recent than lastFailureAt', () => {
    const gate = makeGate({
      lastFailureAt: 1000,
      lastPassAt: 2000, // more recent than last failure → currently passing
    })
    const html = renderControlRoom([gate])
    expect(html).toContain('data-testid="gate-status-passing"')
    expect(html).not.toContain('data-testid="gate-status-failing"')
    // Last pass is shown as primary detail
    expect(html).toContain('data-testid="gate-last-pass"')
    // Last failure shown as secondary (muted)
    expect(html).toContain('data-testid="gate-last-failure"')
  })

  it('renders failing status badge when lastFailureAt is more recent than lastPassAt', () => {
    const gate = makeGate({
      lastPassAt: 1000,
      lastFailureAt: 2000, // more recent than last pass → currently failing
    })
    const html = renderControlRoom([gate])
    expect(html).toContain('data-testid="gate-status-failing"')
    expect(html).not.toContain('data-testid="gate-status-passing"')
  })

  it('renders failing status badge when lastFailureAt is set but lastPassAt is null', () => {
    const gate = makeGate({
      lastPassAt: null,
      lastFailureAt: 5000,
    })
    const html = renderControlRoom([gate])
    expect(html).toContain('data-testid="gate-status-failing"')
  })

  it('shows no run-status badge when neither lastPassAt nor lastFailureAt is recorded', () => {
    const gate = makeGate({ lastPassAt: null, lastFailureAt: null })
    const html = renderControlRoom([gate])
    expect(html).not.toContain('data-testid="gate-status-passing"')
    expect(html).not.toContain('data-testid="gate-status-failing"')
  })

  it('shows quarantine banner when a required gate is quarantined', () => {
    const gate = makeGate({
      state: 'quarantined',
      required: true,
    })
    const html = renderControlRoom([gate])
    expect(html).toContain('data-testid="quarantine-banner"')
    expect(html).toContain('merges are proceeding unchecked')
    expect(html).toContain('typecheck')
  })

  it('does not show quarantine banner when only advisory gates are quarantined', () => {
    const gate = makeGate({
      state: 'quarantined',
      required: false, // advisory, not required
    })
    const html = renderControlRoom([gate])
    expect(html).not.toContain('data-testid="quarantine-banner"')
  })

  it('does not show quarantine banner when all gates are active', () => {
    const gate = makeGate({ state: 'active' })
    const html = renderControlRoom([gate])
    expect(html).not.toContain('data-testid="quarantine-banner"')
  })

  it('shows Quarantine button for active gates', () => {
    const gate = makeGate({ state: 'active' })
    const html = renderControlRoom([gate])
    expect(html).toContain('data-testid="gate-quarantine-btn"')
    expect(html).not.toContain('data-testid="gate-restore-btn"')
  })

  it('shows Restore button for quarantined gates (not Quarantine)', () => {
    const gate = makeGate({ state: 'quarantined' })
    const html = renderControlRoom([gate])
    expect(html).toContain('data-testid="gate-restore-btn"')
    expect(html).not.toContain('data-testid="gate-quarantine-btn"')
  })

  it('shows Retire button for every gate regardless of state', () => {
    const active = makeGate({ id: 'gate-a', state: 'active' })
    const quarantined = makeGate({ id: 'gate-q', state: 'quarantined' })
    const html = renderControlRoom([active, quarantined])
    // Both rows have a Retire button (two occurrences)
    expect(html.match(/data-testid="gate-retire-btn"/g)?.length).toBe(2)
  })

  it('shows "passing" badge text for a currently-passing gate', () => {
    const gate = makeGate({ lastFailureAt: 1000, lastPassAt: 2000 })
    const html = renderControlRoom([gate])
    // The badge inner text must say "passing" (not "failing")
    expect(html).toContain('>passing<')
    expect(html).not.toContain('>failing<')
  })

  it('shows "failing" badge text for a currently-failing gate', () => {
    const gate = makeGate({ lastPassAt: 1000, lastFailureAt: 2000 })
    const html = renderControlRoom([gate])
    expect(html).toContain('>failing<')
    expect(html).not.toContain('>passing<')
  })

  it('shows "Last passed:" label text for a currently-passing gate', () => {
    const gate = makeGate({ lastFailureAt: 1000, lastPassAt: 2000 })
    const html = renderControlRoom([gate])
    expect(html).toContain('Last passed:')
  })

  it('shows "Last failure:" label text for a currently-failing gate', () => {
    const gate = makeGate({ lastPassAt: null, lastFailureAt: 5000 })
    const html = renderControlRoom([gate])
    expect(html).toContain('Last failure:')
  })

  it('shows no badge and no run-date labels when the gate has never run', () => {
    const gate = makeGate({ lastPassAt: null, lastFailureAt: null })
    const html = renderControlRoom([gate])
    expect(html).not.toContain('>passing<')
    expect(html).not.toContain('>failing<')
    expect(html).not.toContain('Last passed:')
    expect(html).not.toContain('Last failure:')
  })
})

// ---------------------------------------------------------------------------
// ControlRoomPage — EngineSection (daemon-code-drift restart action)
// ---------------------------------------------------------------------------

const makeDriftItem = (): import('@/shared/schemas').ActionQueueItem => ({
  id: 'drift-item-1',
  entityId: 'daemon-code-drift',
  kind: 'daemon-code-drift',
  priority: 'normal' as const,
  title: 'Engine update available — 1 commit behind',
  body: 'f3f7fa8 → 9f37c2a — restart to pick up changes.',
  at: '2026-01-01T00:00:00Z',
  dag: null,
  errorKind: 'daemon-code-drift',
  actions: [],
  decisions: [],
  humanSummary: 'Engine update available',
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
})

const makeRunningTask = (overrides: Partial<{ id: string; intent: string | null; prompt: string }> = {}) => ({
  id: overrides.id ?? 'task-1',
  prompt: overrides.prompt ?? 'Fix the authentication bug in the login flow',
  intent: overrides.intent !== undefined ? overrides.intent : 'Fix auth bug',
  status: 'running',
  cluster: 'In progress' as const,
  plan: null,
  branch: 'task/task-1',
  worktreePath: null,
  error: null,
  dropReason: null,
  recoverySpawnedCount: 0,
  priority: 1,
  blockedBy: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T01:00:00Z',
})

describe('ControlRoomPage — Engine section: no drift', () => {
  beforeEach(() => {
    mockUseDispatchState.mockReturnValue({ paused: false, reason: null, since: null, detail: null })
    mockUseActionQueue.mockReturnValue({ items: [], serverGroups: [], error: null, isPending: false })
    mockUseProgress.mockReturnValue(emptyProgressState())
  })

  it('does not render the engine section when no drift is detected', () => {
    const html = renderControlRoom()
    expect(html).not.toContain('data-testid="engine-drift-section"')
    expect(html).not.toContain('data-testid="restart-engine-btn"')
  })
})

describe('ControlRoomPage — Engine section: drift detected, no tasks in flight', () => {
  beforeEach(() => {
    mockUseDispatchState.mockReturnValue({ paused: false, reason: null, since: null, detail: null })
    mockUseActionQueue.mockReturnValue({
      items: [makeDriftItem()],
      serverGroups: [],
      error: null,
      isPending: false,
    })
    mockUseProgress.mockReturnValue(emptyProgressState())
    mockInvokeAction.mockResolvedValue(undefined)
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders the engine section and Restart engine button', () => {
    const html = renderControlRoom()
    expect(html).toContain('data-testid="engine-drift-section"')
    expect(html).toContain('data-testid="restart-engine-btn"')
    expect(html).toContain('Restart engine')
  })

  it('does not show the in-flight warning when no tasks are running', () => {
    const html = renderControlRoom()
    expect(html).not.toContain('data-testid="engine-running-count"')
  })

  it('fires invokeAction directly without a confirm dialog on click (safe case)', async () => {
    const { container } = renderInteractive()
    const btn = container.querySelector('[data-testid="restart-engine-btn"]') as HTMLButtonElement
    expect(btn).not.toBeNull()

    await act(async () => {
      btn.click()
    })

    expect(mockInvokeAction).toHaveBeenCalledWith('restart-daemon')
    // No confirm dialog: the confirm-btn is never rendered since no tasks were in flight
    expect(container.querySelector('[data-testid="engine-restart-confirm-btn"]')).toBeNull()
  })
})

describe('ControlRoomPage — Engine section: drift detected, tasks in flight', () => {
  const task1 = makeRunningTask({ id: 'task-1', intent: 'Fix auth bug' })
  const task2 = makeRunningTask({ id: 'task-2', intent: 'Add rate limiting' })
  const task3 = makeRunningTask({ id: 'task-3', intent: 'Refactor queue module' })

  beforeEach(() => {
    mockUseDispatchState.mockReturnValue({ paused: false, reason: null, since: null, detail: null })
    mockUseActionQueue.mockReturnValue({
      items: [makeDriftItem()],
      serverGroups: [],
      error: null,
      isPending: false,
    })
    mockUseProgress.mockReturnValue({
      ...emptyProgressState(),
      tasks: [task1, task2, task3],
      byCluster: {
        ...emptyProgressState().byCluster,
        'In progress': [task1, task2, task3],
      },
    })
    mockInvokeAction.mockResolvedValue(undefined)
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('shows the in-flight count warning in static render', () => {
    const html = renderControlRoom()
    expect(html).toContain('data-testid="engine-running-count"')
    expect(html).toContain('3 tasks are currently running')
  })

  it('opens a confirm dialog quoting the task count on click', async () => {
    const { container } = renderInteractive()
    const btn = container.querySelector('[data-testid="restart-engine-btn"]') as HTMLButtonElement
    expect(btn).not.toBeNull()

    await act(async () => {
      btn.click()
    })

    // invokeAction must NOT have fired yet — waiting for explicit confirm
    expect(mockInvokeAction).not.toHaveBeenCalled()

    // Dialog uses createPortal → content is in document.body, not inside container
    const confirmBody = document.querySelector('[data-testid="engine-restart-confirm-body"]')
    expect(confirmBody).not.toBeNull()
    expect(confirmBody!.textContent).toContain('3 tasks are')
  })

  it('fires invokeAction after the explicit confirm click', async () => {
    const { container } = renderInteractive()
    const btn = container.querySelector('[data-testid="restart-engine-btn"]') as HTMLButtonElement

    // Open the confirm dialog
    await act(async () => {
      btn.click()
    })

    // Dialog uses createPortal → content is in document.body, not inside container
    const confirmBtn = document.querySelector('[data-testid="engine-restart-confirm-btn"]') as HTMLButtonElement
    expect(confirmBtn).not.toBeNull()

    // Click the confirm button inside the dialog
    await act(async () => {
      confirmBtn.click()
    })

    expect(mockInvokeAction).toHaveBeenCalledWith('restart-daemon')
  })
})
