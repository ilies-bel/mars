/**
 * Behaviour tests for StewardPage (#/steward).
 *
 * The page must:
 *   - render the capability lanes, including standing verify-gate health
 *   - show a status note explaining the steward is not wired up in operator terms
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
import { formatAbsoluteDateTime, formatShortDate } from '@/shared/time'

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
    model: 'claude-sonnet-5',
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

  it('does not show the not-wired-up note — the Steward is wired up and has been dialling the cap', () => {
    // The note claimed the Steward is not wired up, but it moved the implement cap
    // on 2026-08-25. Now that the page reads steward_ledger the blanket assertion is
    // false and the note must be absent entirely.
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).not.toContain('not wired up in this build')
    expect(html).not.toContain('Nothing on this page acts on the queue')
    expect(html).not.toContain('steward-status-note')
    // Must still NOT expose code-review internals to the operator
    expect(html).not.toContain('server.ts:')
    expect(html).not.toContain('investigateWorktree')
    expect(html).not.toContain('runClaudeCode')
  })

  it('renders a cap change that is minutes old as the last activity — cannot present as 24 days stale', () => {
    // Regression guard: the page previously read chat_messages WHERE kind='acknowledgment',
    // a dead source. The newest row there was from 2026-08-01. steward_ledger has live
    // rows from today, so a recent cap change must appear as last activity.
    const recentTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 min ago
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView({
        runtimeTuning: {
          ...makeStewardView().runtimeTuning,
          acks: [
            {
              text: 'I bumped implement workers from 8 to 11.',
              timestamp: recentTimestamp,
              pair: { from: 8, to: 11 },
            },
          ],
        },
      }),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain(`last activity ${formatShortDate(recentTimestamp)}`)
    // Must NOT show any date in August 2026 that would suggest the stale source
    expect(html).not.toContain('last activity 1 Aug')
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

  it('renders ack timestamps through the shared unambiguous formatter', () => {
    // Regression: Steward acks used to render via bare toLocaleString(), which
    // produces an ambiguous numeric date like 01/08/2026 in some locales.
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain(formatAbsoluteDateTime('2026-01-01T00:00:00Z'))
    expect(html).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/)
  })

  it('does not claim the runtime tuning lane is "executing" — the page-level banner already says the Steward is not wired up, so this indicator must not contradict it', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    const laneMatch = /<article[^>]*data-testid="lane-runtime-tuning"[\s\S]*?<\/article>/.exec(html)
    expect(laneMatch).not.toBeNull()
    const headerMatch = /<header[\s\S]*?<\/header>/.exec(laneMatch![0])
    expect(headerMatch).not.toBeNull()
    const header = headerMatch![0]

    // No form of "executing" (visible text or aria-label), and the status
    // dot/chip themselves must not use success/green styling. (The card's
    // ambient success-tinted theming — border, ack entries — is a separate,
    // still-accurate signal that the underlying cap-ratchet mechanism is
    // real; only the claim that *this is the Steward, executing* is wrong.)
    expect(header).not.toContain('executing')
    expect(header).not.toContain('bg-success')

    // Instead it must state the age of the data it is showing.
    expect(header).toContain('runtime-tuning-status-chip')
    expect(header).toContain('last activity')
  })

  it('shows the age of the runtime tuning data so stale acks cannot read as current', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView({
        runtimeTuning: {
          ...makeStewardView().runtimeTuning,
          acks: [
            {
              text: 'I bumped implement workers from 15 to 16.',
              timestamp: '2026-01-03T00:00:00Z', // newest-first, per the API contract
              pair: { from: 15, to: 16 },
            },
          ],
        },
      }),
      isLoading: false,
      error: null,
    })
    const html = renderToStaticMarkup(<StewardPage />)
    const expectedLabel = `last activity ${formatShortDate('2026-01-03T00:00:00Z')}`
    expect(html).toContain(expectedLabel)
  })

  it('renders worker-cap history as a step chart with time axis, not a raw arrow run', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    // Step chart must be present
    expect(html).toContain('data-testid="cap-step-chart"')
    // Baseline and ceiling reference markers are present (on bar)
    expect(html).toContain('baseline: 8')
    expect(html).toContain('ceiling: 16')
    // Raw transition arrows must NOT appear outside the details disclosure
    const htmlWithoutDetails = html.replace(/<details[\s\S]*?<\/details>/g, '')
    expect(htmlWithoutDetails).not.toContain('→')
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
    expect(html).toContain('mars daemon reset-breaker')
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
    expect(html).toContain('This lane cannot execute.')
    // Must NOT say "Nothing yet" (implies waiting)
    expect(html).not.toContain('Nothing yet')
  })

  it('shows active workflow-patches lane with arc-verifier badge when hasCallers is true', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: makeStewardView({ workflowPatches: { rows: [], hasCallers: true } }),
      isLoading: false,
      error: null,
    })

    const html = renderToStaticMarkup(<StewardPage />)

    // Active lane: arc-verifier badge, not the inert badge
    expect(html).toContain('arc-verifier')
    expect(html).not.toContain('built — no callers')
    // Trigger description explains the E2E tooling-missing path
    // (apostrophe may be HTML-escaped in static markup; match the unescaped key term)
    expect(html).toContain('VERIFY')
    expect(html).toContain('behaviour-verify')
    // Lane is active (executing status dot)
    expect(html).toContain('executing')
  })

  // ---------------------------------------------------------------------------
  // Verify gate health lane
  // ---------------------------------------------------------------------------

  
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

  it('says in a sentence that nothing calls the agent, rather than "(0 dispatch sites)"', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('Nothing calls this agent')
    expect(html).toContain('claude-sonnet-5')
    // The old heading required knowing what a dispatch site is to notice that
    // the page's namesake agent never runs.
    expect(html).not.toContain('0 dispatch site')
  })
})


// ---------------------------------------------------------------------------
// Acknowledgment log — summary, preview, disclosure
//
// This rendered every acknowledgment as an equal card: with 200 of them, some
// twelve thousand pixels of scroll in which the same sentence appeared dozens
// of times. Each row was readable and the list as a whole said nothing — you
// could not learn how often the Steward acts, which way, or within what range
// without scrolling all of it and counting.
// ---------------------------------------------------------------------------

const ack = (from: number, to: number, day: number) => ({
  text: `I ${to > from ? 'bumped' : 'shed'} implement workers from ${from} to ${to}.`,
  timestamp: `2026-02-${String(day).padStart(2, '0')}T00:00:00Z`,
  pair: { from, to },
})

const withAcks = (acks: ReturnType<typeof ack>[]) => {
  const base = makeStewardView()
  return { ...base, runtimeTuning: { ...base.runtimeTuning, acks } }
}

describe('StewardPage — acknowledgment log', () => {
  beforeEach(() => {
    vi.mocked(useStewardView).mockReturnValue({
      data: withAcks([
        ack(4, 5, 1), ack(5, 6, 2), ack(6, 4, 3),
        ack(4, 5, 4), ack(5, 6, 5), ack(6, 4, 6),
        ack(4, 5, 7), ack(5, 6, 8),
      ]),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useStewardView>)
  })

  it('states the shape of the whole set in one line', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    // 6 bumps (4→5, 5→6 ×3 each pattern), 2 sheds (6→4), levels span 4..6.
    expect(html).toContain('data-testid="steward-ack-summary"')
    expect(html).toContain('6 bumps, 2 sheds')
    expect(html).toContain('holding between 4 and 6 workers')
  })

  it('classifies direction from the structured pair, not from the sentence', () => {
    // The prose is the Steward's to word. A regex over it would quietly stop
    // counting the day the wording changed, so the copy here is deliberately
    // uninformative while the pairs are not.
    const html = renderToStaticMarkup(<StewardPage />)
    vi.mocked(useStewardView).mockReturnValue({
      data: withAcks([
        { text: 'Adjusted capacity.', timestamp: '2026-03-01T00:00:00Z', pair: { from: 2, to: 9 } },
        { text: 'Adjusted capacity.', timestamp: '2026-03-02T00:00:00Z', pair: { from: 9, to: 2 } },
      ]),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useStewardView>)
    const opaque = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('6 bumps, 2 sheds')
    expect(opaque).toContain('1 bump, 1 shed')
    expect(opaque).toContain('holding between 2 and 9 workers')
  })

  it('singularises the counts', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: withAcks([ack(4, 5, 1), ack(5, 4, 2)]),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useStewardView>)
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('1 bump, 1 shed')
    expect(html).not.toContain('1 bumps')
    expect(html).not.toContain('1 sheds')
  })

  it('folds everything past the preview behind a disclosure that counts it', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    // 8 acks, 6 previewed → 2 earlier.
    expect(html).toContain('2 earlier')
  })

  it('keeps every acknowledgment — the disclosure hides, it does not drop', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    // All eight timestamps are still in the markup, just not all expanded.
    for (const day of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const stamp = formatAbsoluteDateTime(`2026-02-0${day}T00:00:00Z`)
      expect(html, `ack for day ${day} missing`).toContain(stamp)
    }
  })

  it('adds no disclosure when everything already fits in the preview', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: withAcks([ack(4, 5, 1), ack(5, 6, 2)]),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useStewardView>)
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).not.toContain('earlier')
  })

  it('keeps the newest acknowledgment first and marked', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('data-testid="steward-ack-latest"')
  })

  it('marks each row with its direction, from the pair and not the prose', () => {
    // Every acknowledgment used to render in the same tinted box, so a raise
    // and a cut were typographically identical and finding the two rows that
    // went the other way meant reading six near-identical sentences word by
    // word. The Steward's whole subject is oscillation.
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('data-direction="up"')
    expect(html).toContain('data-direction="down"')
  })

  it('classifies the row direction from the pair even when the prose says nothing', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: withAcks([
        { text: 'Adjusted capacity.', timestamp: '2026-03-01T00:00:00Z', pair: { from: 2, to: 9 } },
        { text: 'Adjusted capacity.', timestamp: '2026-03-02T00:00:00Z', pair: { from: 9, to: 2 } },
      ]),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useStewardView>)
    const html = renderToStaticMarkup(<StewardPage />)
    // Same sentence on both rows; only `pair` distinguishes them.
    expect(html).toContain('data-direction="up"')
    expect(html).toContain('data-direction="down"')
  })

  it('states the direction in words, so it is never carried by colour alone', () => {
    // WCAG 1.4.1: a green arrow and an amber arrow differ in shape as well as
    // hue, and the verb is spoken outright for anyone who sees neither.
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('raised:')
    expect(html).toContain('lowered:')
  })

  it('shows a neutral row rather than guessing when the daemon sent no levels', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: withAcks([
        { text: 'Adjusted capacity.', timestamp: '2026-03-01T00:00:00Z', pair: null },
      ]),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useStewardView>)
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('data-direction="flat"')
    expect(html).toContain('unchanged:')
    expect(html).not.toContain('data-direction="up"')
    expect(html).not.toContain('data-direction="down"')
  })

  it('puts the verdict in the header instead of a noun and a total', () => {
    // "Steward acknowledgments (200)" made the reader scroll two hundred rows
    // to learn the only thing the section is for.
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('Steward acknowledgments')
    expect(html).not.toContain('Steward acknowledgments (')
  })

  it('says so plainly when there is nothing to summarise', () => {
    vi.mocked(useStewardView).mockReturnValue({
      data: withAcks([]),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useStewardView>)
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('No acknowledgments yet.')
    expect(html).not.toContain('data-testid="steward-ack-summary"')
  })
})


// ---------------------------------------------------------------------------
// Disclosure triggers must be tellable apart by name
//
// Every verify gate renders up to two "Technical details" disclosures. On the
// live page that is nine identical accessible names: a screen-reader user
// tabbing through hears "Technical details, collapsed" nine times with nothing
// to say which gate each belongs to (WCAG 2.4.6 / 4.1.2). Visually each is
// anchored by the gate above it, which is why a purely visual audit misses it.
// ---------------------------------------------------------------------------

describe('StewardPage — gate disclosures are individually named', () => {
  })

// ---------------------------------------------------------------------------
// Verify gates — summarised, not restated
// ---------------------------------------------------------------------------

describe('StewardPage – verify gates hand off to the Control Room', () => {
  it('states the registry size and links out instead of listing every gate', () => {
    const html = renderToStaticMarkup(<StewardPage />)
    expect(html).toContain('data-testid="gates-handoff"')
    expect(html).toContain('#/control')
    // The word this page used to print over a failing gate. It means "not
    // quarantined" and this payload carries no run status at all, so the page
    // cannot say whether anything passes — and must not imply it does.
    expect(html).not.toContain('>Active<')
  })
})
