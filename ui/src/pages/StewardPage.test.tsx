/**
 * Behaviour tests for StewardPage (#/steward).
 *
 * The page must:
 *   - render the capability lanes, including standing verify-gate health
 *   - show the misnomer callout (server.ts misnomer note)
 *   - display storm breach state correctly (tripped / clear)
 *   - show a disagreement banner when tripped ≠ isPaused
 *   - render runtime tuning acks
 *   - show inert-not-waiting empty state for workflow patches
 *   - show active and quarantined verify gates with their evidence
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
import { StewardViewSchema } from './steward-view-schema'

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
  gateHealth: {
    scopes: [
      {
        scope: '.',
        gates: [
          {
            id: 'gate-typecheck',
            scope: '.',
            name: 'typecheck',
            tier: 'task',
            required: true,
            state: 'quarantined',
            source: 'human',
            command: { cmd: 'npx', args: ['tsc', '--noEmit'] },
            quarantinedAt: 1767225600000,
            quarantineSignature: 'verify:typecheck:exit-1',
            lastFailureSignature: 'verify:typecheck:exit-1',
            lastFailureOriginId: 'origin-123',
            lastFailureAt: 1767225600000,
          },
        ],
      },
      {
        scope: 'ui',
        gates: [
          {
            id: 'gate-test',
            scope: 'ui',
            name: 'test',
            tier: 'task',
            required: true,
            state: 'active',
            source: 'human',
            command: { cmd: 'npx', args: ['vitest', 'run'] },
            quarantinedAt: null,
            quarantineSignature: null,
            lastFailureSignature: null,
            lastFailureOriginId: null,
            lastFailureAt: null,
          },
        ],
      },
    ],
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
  // Verify gate health
  // ---------------------------------------------------------------------------

  it('rejects unknown verify gate states from the daemon response', () => {
    const invalidResponse = {
      ...makeStewardView(),
      gateHealth: {
        scopes: [{
          scope: '.',
          gates: [{
            ...makeStewardView().gateHealth.scopes[0]!.gates[0]!,
            state: 'repairing',
          }],
        }],
      },
    }

    expect(StewardViewSchema.safeParse(invalidResponse).success).toBe(false)
  })

  it('renders one verify-gate section per scope with active and quarantined labels', () => {
    const html = renderToStaticMarkup(<StewardPage />)

    expect(html).toContain('Verify gates')
    expect(html).toContain('Scope: .')
    expect(html).toContain('Scope: ui')
    expect(html).toContain('typecheck')
    expect(html).toContain('test')
    expect(html).toContain('Quarantined')
    expect(html).toContain('Active')
    expect(html).toContain('npx tsc --noEmit')
  })

  it('shows quarantine and latest failure evidence for quarantined gates', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    const timestamp = new Date(1767225600000).toLocaleString()

    expect(html).toContain('verify:typecheck:exit-1')
    expect(html).toContain('origin-123')
    expect(html).toContain(timestamp)
  })

  it('shows an explicit empty state when no verify gates are registered', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView({ gateHealth: { scopes: [] } }),
      isLoading: false,
      error: null,
    })

    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('No verify gates are registered.')
  })

  // ---------------------------------------------------------------------------
  // Basic structure
  // ---------------------------------------------------------------------------

  it('renders all capability lane titles', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('Runtime tuning')
    expect(html).toContain('Signature storm')
    expect(html).toContain('Workflow patches')
    expect(html).toContain('Verify gates')
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
  // Verify gate health lane
  // ---------------------------------------------------------------------------

  it('renders the standing verify-gate registry rather than an unbuilt placeholder', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('standing registry')
    expect(html).not.toContain('Implementation not started')
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
    expect(html).toContain('Loading verify gates')
  })

  it('renders a fallback alert when the fetch errors', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('daemon unreachable'),
    })
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Daemon error while loading verify gates')
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
