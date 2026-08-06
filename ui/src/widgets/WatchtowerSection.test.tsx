// @vitest-environment happy-dom

/**
 * Behaviour tests for WatchtowerSection's scoring-empty-state handling.
 *
 * The surface must never render a blank chart when no scorer has been accepted
 * yet. Instead it surfaces:
 *  1. Pending suggestions (name, workflow, confidence, rubric).
 *  2. An explanation that zero accepted scorers means nothing is graded.
 *  3. An explanation that the auto-reflect trigger cannot fire.
 *  4. An Accept button per suggestion that, when confirmed, POSTs to
 *     /api/scorer-accept with the scorer's id — identical to what
 *     `mars scorer accept <id>` does via the daemon.
 *
 * All HTTP fetches are intercepted at the fetch() boundary (the system
 * boundary between the UI and the daemon). No internal helpers are mocked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WatchtowerSection } from './WatchtowerSection'

// ---------------------------------------------------------------------------
// Fixture payloads
// ---------------------------------------------------------------------------

const WORKFLOWS_EMPTY = { workflows: [] }
const SUGGESTIONS_EMPTY = { scorers: [] }
const LEDGER_EMPTY = { entries: [] }

const SUGGESTIONS_WITH_DATA = {
  scorers: [
    {
      id: 'bc1661fb',
      workflow: 'task',
      title: 'Production-path completeness',
      rubric: 'Does the diff wire the production entry point for the feature it claims to ship?',
      status: 'suggested',
      confidence: 0.93,
      evidence: ['verify passed vacuously while handler was unwired'],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
    },
    {
      id: 'fd89af2f',
      workflow: 'fix',
      title: 'Recovery-run necessity and non-redundancy',
      rubric: 'Is the recovery task actually needed and non-redundant?',
      status: 'suggested',
      confidence: 0.75,
      evidence: [],
      createdAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_001,
    },
  ],
}

/** Build a JSON Response with proper content-type header */
const jsonResp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

/**
 * Create a fetch mock that routes based on path substring.
 * Secondary endpoints (promotion-ledger, loop-ledger) return proper empty JSON
 * so Zod validation passes and React Query does not enter an error state.
 */
type RouteMap = Record<string, unknown>

const makeFetch =
  (routes: RouteMap, acceptCallback?: (body: unknown) => Response | Promise<Response>) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input)

    for (const [key, payload] of Object.entries(routes)) {
      if (path.includes(key)) {
        return jsonResp(payload)
      }
    }

    // Accept endpoint with optional callback
    if (path.includes('/api/scorer-accept') && acceptCallback) {
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null
      return acceptCallback(body)
    }

    // Default: promotion-ledger, loop-ledger, anything else — return empty JSON
    return jsonResp(LEDGER_EMPTY)
  }

/** Render WatchtowerSection inside a QueryClientProvider and return the container. */
const render = async (
  qc: QueryClient,
  fetchMock: typeof fetch,
): Promise<HTMLDivElement> => {
  vi.stubGlobal('fetch', fetchMock)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(WatchtowerSection)),
    )
  })
  return container
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

/** Let React Query resolve pending queries */
const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

// ---------------------------------------------------------------------------
// Tests — empty state with suggested scorers
// ---------------------------------------------------------------------------

describe('WatchtowerSection – empty state with no accepted scorers', () => {
  it('shows the "0 accepted scorers" explanation when workflows is empty and suggestions exist', async () => {
    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch({
        '/api/scorer-workflows': WORKFLOWS_EMPTY,
        '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
      }),
    )

    await settle()
    await settle()

    const text = container.textContent ?? ''
    expect(text).toContain('0 accepted scorers')
  })

  it('never shows a blank chart when suggestions are pending', async () => {
    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch({
        '/api/scorer-workflows': WORKFLOWS_EMPTY,
        '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
      }),
    )

    await settle()
    await settle()

    // An SVG score-trend chart must NOT appear — there is no data to chart
    const svgs = container.querySelectorAll('svg[aria-label*="Score trend"]')
    expect(svgs).toHaveLength(0)

    // The suggestion panel must render instead
    expect(container.textContent).toContain('Production-path completeness')
  })

  it('shows suggestion name, workflow, and confidence for each pending scorer', async () => {
    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch({
        '/api/scorer-workflows': WORKFLOWS_EMPTY,
        '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
      }),
    )

    await settle()
    await settle()

    const text = container.textContent ?? ''

    expect(text).toContain('Production-path completeness')
    expect(text).toContain('Recovery-run necessity and non-redundancy')
    expect(text).toContain('task')
    expect(text).toContain('fix')
    expect(text).toContain('93%')
    expect(text).toContain('75%')
  })

  it('surfaces the rubric of each suggestion so the operator can read it before accepting', async () => {
    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch({
        '/api/scorer-workflows': WORKFLOWS_EMPTY,
        '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
      }),
    )

    await settle()
    await settle()

    expect(container.textContent).toContain(
      'Does the diff wire the production entry point',
    )
  })

  it('states that the low-trend auto-reflect trigger cannot fire with no accepted scorers', async () => {
    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch({
        '/api/scorer-workflows': WORKFLOWS_EMPTY,
        '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
      }),
    )

    await settle()
    await settle()

    const text = container.textContent ?? ''
    expect(text).toContain('auto-reflect trigger')
    expect(text).toContain('cannot fire')
  })

  it('shows a no-suggestions fallback when both workflows and suggestions are empty', async () => {
    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch({
        '/api/scorer-workflows': WORKFLOWS_EMPTY,
        '/api/scorer-suggestions': SUGGESTIONS_EMPTY,
      }),
    )

    await settle()
    await settle()

    const text = container.textContent ?? ''
    expect(text).toContain('No scores yet')

    // No chart SVGs
    const svgs = container.querySelectorAll('svg[aria-label*="Score trend"]')
    expect(svgs).toHaveLength(0)
  })

  it('renders an Accept button for each suggestion — no scorer is auto-accepted', async () => {
    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch({
        '/api/scorer-workflows': WORKFLOWS_EMPTY,
        '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
      }),
    )

    await settle()
    await settle()

    // There must be Accept buttons (one per suggestion)
    const acceptButtons = container.querySelectorAll('button[aria-label^="Accept scorer"]')
    expect(acceptButtons.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Tests — accept routes through the acceptance path
// ---------------------------------------------------------------------------

describe('WatchtowerSection – accept routes through the acceptance path', () => {
  it('POSTs the scorer id to /api/scorer-accept when the user clicks Accept and confirms', async () => {
    const postedBodies: unknown[] = []

    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch(
        {
          '/api/scorer-workflows': WORKFLOWS_EMPTY,
          '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
        },
        (body) => {
          postedBodies.push(body)
          return jsonResp({
            scorer: {
              id: 'bc1661fb',
              workflow: 'task',
              title: 'Production-path completeness',
              rubric:
                'Does the diff wire the production entry point for the feature it claims to ship?',
              status: 'accepted',
              confidence: 0.93,
              evidence: ['verify passed vacuously while handler was unwired'],
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_002_000,
            },
          })
        },
      ),
    )

    await settle()
    await settle()

    // Click the Accept button for the first scorer (bc1661fb)
    const acceptButton = container.querySelector(
      'button[aria-label="Accept scorer: Production-path completeness"]',
    ) as HTMLButtonElement | null
    expect(acceptButton).not.toBeNull()

    await act(async () => {
      acceptButton!.click()
    })

    // A Confirm button must appear (two-step confirmation)
    const confirmButton = container.querySelector(
      'button[aria-label="Confirm accepting scorer: Production-path completeness"]',
    ) as HTMLButtonElement | null
    expect(confirmButton).not.toBeNull()

    await act(async () => {
      confirmButton!.click()
    })

    await settle()

    // The POST must have been sent with the correct scorer id
    expect(postedBodies).toHaveLength(1)
    expect(postedBodies[0]).toEqual({ id: 'bc1661fb' })
  })

  it('does not POST to /api/scorer-accept until the user explicitly confirms', async () => {
    const acceptCalls: unknown[] = []
    const qc = buildClient()

    const container = await render(
      qc,
      makeFetch(
        {
          '/api/scorer-workflows': WORKFLOWS_EMPTY,
          '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
        },
        (body) => {
          acceptCalls.push(body)
          return jsonResp({ scorer: {} })
        },
      ),
    )

    await settle()
    await settle()

    // Click Accept (first step — shows confirmation UI, no POST yet)
    const acceptButton = container.querySelector(
      'button[aria-label="Accept scorer: Production-path completeness"]',
    ) as HTMLButtonElement | null

    await act(async () => {
      acceptButton!.click()
    })

    // No POST yet — only the confirmation step was triggered
    expect(acceptCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests — live data path (regression guard)
// ---------------------------------------------------------------------------

describe('WatchtowerSection – live data path (no regression)', () => {
  it('renders trend charts when workflows have results — suggestion panel absent', async () => {
    const workflowsWithData = { workflows: ['task'] }
    const trendData = {
      trends: [{ workflow: 'task', median: 0.8, p90: 0.9, count: 5 }],
      recent: [
        {
          id: 'sr-1',
          scorerId: 'sc-1',
          taskId: 'task-1',
          workflow: 'task',
          score: 0.8,
          rationale: 'ok',
          status: 'scored',
          createdAt: 1_700_000_000_000,
          workflowConfigVersionId: null,
        },
      ],
    }

    const qc = buildClient()
    const container = await render(
      qc,
      makeFetch({
        '/api/scorer-workflows': workflowsWithData,
        '/api/scorer-trend': trendData,
        '/api/workflow-configs': { configs: [] },
        '/api/scorer-suggestions': SUGGESTIONS_WITH_DATA,
      }),
    )

    await settle()
    await settle()

    // When there are results, the suggestion panel must NOT appear
    expect(container.textContent).not.toContain('0 accepted scorers')
  })
})
