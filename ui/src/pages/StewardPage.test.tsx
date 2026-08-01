/**
 * Behaviour tests for StewardPage (#/steward).
 *
 * The page must:
 *   - render all four capability lanes with their lane titles
 *   - show the misnomer callout (server.ts misnomer note)
 *   - display storm breach state correctly (tripped / clear)
 *   - show a disagreement banner when tripped ≠ isPaused
 *   - render runtime tuning acks
 *   - show inert-not-waiting empty state for workflow patches
 *   - show quarantine as decided-not-built
 *   - show a loading skeleton while data is loading
 *   - show a fallback alert when the fetch errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StewardView } from './useStewardView'
import { StewardPage } from './StewardPage'

vi.mock('./useStewardView', () => ({
  useStewardView: vi.fn(),
}))

import { useStewardView } from './useStewardView'

const makeStewardView = (overrides: Partial<StewardView> = {}): StewardView => ({
  runtimeTuning: {
    acks: [
      {
        text: 'I bumped implement workers from 8 to 11 because the backlog stayed hot.',
        timestamp: '2026-01-01T00:00:00Z',
        pair: { from: 8, to: 11 },
      },
      {
        text: 'I bumped implement workers from 11 to 15.',
        timestamp: '2026-01-02T00:00:00Z',
        pair: { from: 11, to: 15 },
      },
      {
        text: 'I bumped implement workers from 15 to 16.',
        timestamp: '2026-01-03T00:00:00Z',
        pair: { from: 15, to: 16 },
      },
    ],
    liveCap: 16,
    baselineCap: 8,
    ceiling: 16,
    bumpFactor: 1.33,
    thresholdFactor: 0.75,
    sustainMs: 60000,
    checkMs: 10000,
  },
  workflowPatches: {
    rows: [],
    hasCallers: false,
  },
  signatureStorm: {
    current_signature: 'TypeError: cannot read property',
    streak_count: 5,
    last_task_id: 'task-abc123',
    tripped: true,
    updated_at: '2026-01-03T12:00:00Z',
    signatureStormAqCount: 14,
    tripThreshold: 3,
    isPaused: true,
  },
  agentSpec: {
    name: 'steward',
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Bash', 'Grep', 'Glob'],
    eventVariants: ['kpi-degraded', 'resource-load', 'onboarding', 'workflow-suggestion'],
    dispatchSites: 0,
  },
  ...overrides,
})

describe('StewardPage', () => {
  beforeEach(() => {
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView(),
      isLoading: false,
      error: null,
    })
  })

  // ---------------------------------------------------------------------------
  // Basic structure
  // ---------------------------------------------------------------------------

  it('renders all four lane titles', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('Runtime tuning')
    expect(html).toContain('Signature storm')
    expect(html).toContain('Workflow patches')
    expect(html).toContain('Gate quarantine')
  })

  it('renders the misnomer callout about server.ts', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('misnomer')
    expect(html).toContain('Haiku')
    expect(html).toContain('stewardAgent')
  })

  // ---------------------------------------------------------------------------
  // Runtime tuning lane
  // ---------------------------------------------------------------------------

  it('renders runtime tuning acks in the Steward voice', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('I bumped implement workers from 8 to 11')
    expect(html).toContain('I bumped implement workers from 11 to 15')
    expect(html).toContain('I bumped implement workers from 15 to 16')
  })

  it('renders the executing badge for the runtime tuning lane', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    // The runtime tuning lane should have an 'executing' badge
    expect(html).toContain('executing')
  })

  // ---------------------------------------------------------------------------
  // Signature storm lane
  // ---------------------------------------------------------------------------

  it('shows the breaker as tripped when tripped=true', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView({
        signatureStorm: {
          ...makeStewardView().signatureStorm,
          tripped: true,
          isPaused: true,
        },
      }),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('breaker tripped')
    expect(html).toContain('Tripped')
  })

  it('shows the breaker as clear when tripped=false', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView({
        signatureStorm: {
          ...makeStewardView().signatureStorm,
          tripped: false,
          isPaused: false,
        },
      }),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('breaker clear')
    expect(html).toContain('Clear')
  })

  it('shows a disagreement banner when tripped disagrees with isPaused', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView({
        signatureStorm: {
          ...makeStewardView().signatureStorm,
          tripped: true,
          isPaused: false, // Disagrees: daemon restarted while tripped
        },
      }),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('State disagreement detected')
    expect(html).toContain('mars operator')
  })

  it('does not show a disagreement banner when tripped matches isPaused', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView({
        signatureStorm: {
          ...makeStewardView().signatureStorm,
          tripped: true,
          isPaused: true,
        },
      }),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).not.toContain('State disagreement detected')
  })

  it('renders streak count and trip threshold', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('5')
    expect(html).toContain('/ 3 to trip')
  })

  // ---------------------------------------------------------------------------
  // Workflow patches lane
  // ---------------------------------------------------------------------------

  it('shows inert empty state for workflow patches — says no callers, not nothing yet', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('built — no callers')
    expect(html).toContain('inert, not')
    // Must NOT say "Nothing yet" (implies waiting)
    expect(html).not.toContain('Nothing yet')
  })

  // ---------------------------------------------------------------------------
  // Gate quarantine lane
  // ---------------------------------------------------------------------------

  it('renders gate quarantine as decided-not-built', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('decided — not built')
    expect(html).toContain('Implementation not started')
  })

  // ---------------------------------------------------------------------------
  // Loading and error states
  // ---------------------------------------------------------------------------

  it('renders a loading skeleton while data is loading', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    })
    const html = renderToStaticMarkup(<StewardPage />)
    // Should not render any lane content while loading
    expect(html).not.toContain('Runtime tuning')
    expect(html).not.toContain('Signature storm')
  })

  it('renders a fallback alert when the fetch errors', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('daemon unreachable'),
    })
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('role="alert"')
  })

  // ---------------------------------------------------------------------------
  // Agent spec footer
  // ---------------------------------------------------------------------------

  it('renders the agent spec footer with 0 dispatch sites', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('0 dispatch site')
    expect(html).toContain('claude-sonnet-4-6')
  })
})
