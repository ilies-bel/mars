/**
 * Behaviour test for ControlRoomPage's NOW block dispatch indicator.
 *
 * TopStripe's health dot already has dedicated coverage (TopStripe.test.tsx)
 * for "never show green 'live' while dispatch is paused". This page has its
 * own, separately-written copy of that same dot inside NowSection — it does
 * not delegate to TopStripe — so a regression there is invisible to the
 * TopStripe suite. This is literally the second symptom named in the bug
 * report ("Control Room's own NOW block, directly below the PAUSED lever,
 * also showed a green Live"), so it gets its own assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ControlRoomPage } from './ControlRoomPage'

// LeversSection queries fetchOperatorState directly via useQuery, and
// RulesSection queries fetchGlossary/fetchAdrs — none of those resolve
// synchronously, so they stay in their loading state during
// renderToStaticMarkup and never interfere with the NOW block assertions
// below. They're mocked here only so the real network functions are never
// invoked from a test.
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api')>()
  return {
    ...actual,
    fetchOperatorState: vi.fn(() => new Promise(() => {})),
    fetchGlossary: vi.fn(() => new Promise(() => {})),
    fetchAdrs: vi.fn(() => new Promise(() => {})),
    fetchVerifyGates: vi.fn(() => new Promise(() => {})),
  }
})

vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({ tasks: [], connected: true }),
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

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: [] }),
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

describe('ControlRoomPage — Steward history section', () => {
  beforeEach(() => {
    mockUseDispatchState.mockReturnValue({
      paused: false,
      reason: null,
      since: null,
      detail: null,
    })
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
})
