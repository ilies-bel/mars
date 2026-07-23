/**
 * Unit tests for QueueThreadDetail — the projection-Thread detail pane —
 * and its ActionBar (Decisions, two-step needsConfirm, process-level ops,
 * error-message mapping).
 *
 * Rendered with renderToStaticMarkup inside a pre-warmed QueryClient so the
 * traces / origins / proposal useQuery calls resolve synchronously.
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  QueueThreadDetail,
  PROCESS_LEVEL_OPS,
  actionErrorMessage,
} from './QueueThreadDetail'
import { ApiError } from '@/shared/api'
import type { ActionQueueItem, EventsResponse } from '@/shared/schemas'

const EMPTY_EVENTS: EventsResponse = { events: [], nextCursor: null }

const BASE_ITEM: ActionQueueItem = {
  id: 'failed-task:t-1',
  kind: 'failed-task',
  entityId: 't-1',
  priority: 'normal',
  title: 'Some failed task',
  body: 'verbatim body text',
  at: new Date().toISOString(),
  dag: { blockers: [], blocking: [], descendants: [], proposalId: null, edges: [] },
  errorKind: 'failed-task',
  actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
  diagnosis: null,
  failureReasonCode: 'verify:typecheck',
} as unknown as ActionQueueItem

const makeItem = (overrides: Record<string, unknown>): ActionQueueItem =>
  ({ ...BASE_ITEM, ...overrides } as ActionQueueItem)

const renderDetail = (item: ActionQueueItem): string => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  qc.setQueryData(['events', null, item.entityId], EMPTY_EVENTS)
  qc.setQueryData(['origins', null, item.entityId], {
    node: { id: item.entityId, kind: 'task', title: 'lone task', status: 'failed', children: [] },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <QueueThreadDetail item={item} />
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Decisions (ActionBar)
// ---------------------------------------------------------------------------

describe('QueueThreadDetail – Decisions', () => {
  it('renders a queue alert as Mars’s opening conversation message', () => {
    const html = renderDetail(BASE_ITEM)
    expect(html).toContain('data-testid="queue-opening-message"')
    expect(html).toContain('Opening alert message from Mars')
    expect(html).toContain('Action needed')
  })

  it('renders every Decision the row carries under Move forward', () => {
    const html = renderDetail(
      makeItem({
        actions: [
          { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
          { id: 'restart', label: 'Restart from scratch', op: 'restart' },
          { id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true },
        ],
      }),
    )
    expect(html).toContain('Move forward')
    expect(html).toContain('>Investigate<')
    expect(html).toContain('>Restart from scratch<')
    expect(html).toContain('>Drop permanently<')
  })

  it('renders a copy Decision as a clipboard button (label only, no inline hint)', () => {
    const html = renderDetail(
      makeItem({
        actions: [{ id: 'copy-1', label: 'Move forward', op: 'copy', hint: '/mars:grill t-1' }],
      }),
    )
    expect(html).not.toContain('Move forward · ')
    expect(html).toContain('<button')
  })
})

// ---------------------------------------------------------------------------
// Two-step needsConfirm
// ---------------------------------------------------------------------------

describe('QueueThreadDetail – two-step in-UI confirm', () => {
  const confirmItem = makeItem({
    actions: [{ id: 'purge', label: 'Drop permanently', op: 'purge', needsConfirm: true }],
  })

  it('needsConfirm button shows the plain label in the un-armed state', () => {
    const html = renderDetail(confirmItem)
    expect(html).toContain('>Drop permanently<')
    expect(html).not.toContain('Confirm Drop permanently')
  })

  it('needsConfirm button carries data-testid="confirm-step-<id>" for targeting', () => {
    expect(renderDetail(confirmItem)).toContain('data-testid="confirm-step-purge"')
  })

  it('does NOT carry data-confirm-pending before the first click', () => {
    expect(renderDetail(confirmItem)).not.toContain('data-confirm-pending')
  })
})

// ---------------------------------------------------------------------------
// Kind-specific detail
// ---------------------------------------------------------------------------

describe('QueueThreadDetail – kind-specific detail', () => {
  it('renders goal as the h2 headline and reason below for arc-failed items', () => {
    const html = renderDetail(
      makeItem({
        kind: 'arc-failed',
        entityId: 'origin-abc',
        errorKind: 'arc-failed',
        actions: [],
        goal: 'Refactor the auth module to use JWT tokens',
        reason: 'The coder ran out of context',
        chain: [],
        dag: null,
      }),
    )
    expect(html).toMatch(/<h2[^>]*>.*Refactor the auth module to use JWT tokens.*<\/h2>/s)
    const goalPos = html.indexOf('Refactor the auth module to use JWT tokens')
    const reasonPos = html.indexOf('The coder ran out of context')
    expect(goalPos).toBeGreaterThan(-1)
    expect(reasonPos).toBeGreaterThan(goalPos)
  })

  it('renders the Diagnosis section when item.diagnosis is populated', () => {
    const html = renderDetail(
      makeItem({
        diagnosis: {
          text: 'The task failed because of an unused import.',
          diagnosedAt: '2026-01-01T12:00:00Z',
        },
      }),
    )
    expect(html).toContain('>Diagnosis<')
    expect(html).toContain('The task failed because of an unused import.')
  })

  it('does NOT render a Diagnosis section when item.diagnosis is null', () => {
    expect(renderDetail(BASE_ITEM)).not.toContain('>Diagnosis<')
  })

  it('renders the Open task detail button only for a real failed task', () => {
    expect(renderDetail(BASE_ITEM)).toContain('data-testid="aq-open-task-detail"')
    expect(
      renderDetail(makeItem({ entityId: '__daemon-killed-batch__', id: 'failed-task:batch' })),
    ).not.toContain('data-testid="aq-open-task-detail"')
  })
})

// ---------------------------------------------------------------------------
// Resolution block — resolved history rows suppress the ActionBar
// ---------------------------------------------------------------------------

describe('QueueThreadDetail – Resolution block', () => {
  const resolvedItem = makeItem({
    resolution: {
      resolvedAt: '2024-01-02T00:00:00.000Z',
      resolution: 'superseded',
      resolutionNote: 'origin-done',
      rootCause: null,
      resolvedBy: 'daemon:auto-supersede',
    },
    actions: [],
  })

  it('renders the Resolution block for a resolved row', () => {
    const html = renderDetail(resolvedItem)
    expect(html).toContain('data-testid="resolution-block"')
    expect(html).toContain('superseded')
    expect(html).toContain('daemon:auto-supersede')
  })

  it('hides the ActionBar for a resolved row', () => {
    expect(renderDetail(resolvedItem)).not.toContain('Move forward')
  })

  it('shows the ActionBar and no Resolution block for a live row', () => {
    const html = renderDetail(BASE_ITEM)
    expect(html).toContain('Move forward')
    expect(html).not.toContain('data-testid="resolution-block"')
  })
})

// ---------------------------------------------------------------------------
// PROCESS_LEVEL_OPS — entityId elision contract
// ---------------------------------------------------------------------------

describe('PROCESS_LEVEL_OPS – entityId elision', () => {
  it('restart-all-daemon-killed and restart-daemon are process-level', () => {
    expect(PROCESS_LEVEL_OPS.has('restart-all-daemon-killed')).toBe(true)
    expect(PROCESS_LEVEL_OPS.has('restart-daemon')).toBe(true)
  })

  it('entity-level ops retain their entityId', () => {
    for (const op of ['restart', 'purge', 'diagnose-failure', 'prune-worktree', 'investigate']) {
      expect(PROCESS_LEVEL_OPS.has(op)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Section heading visual treatment
// ---------------------------------------------------------------------------

describe('QueueThreadDetail – section heading border treatment', () => {
  it('Move forward heading carries a border-b divider class', () => {
    const html = renderDetail(BASE_ITEM)
    // The dt element that labels the "Move forward" section must have border-b
    // so it visually separates from its content.
    const dtMatch = html.match(/<dt[^>]*>[^<]*Move forward[^<]*<\/dt>/)
    expect(dtMatch).not.toBeNull()
    expect(dtMatch![0]).toContain('border-b')
  })

  it('Traces heading carries a border-b divider class', () => {
    const html = renderDetail(BASE_ITEM)
    // Traces renders as empty-state (no events seeded) but the dt is still present.
    const dtMatch = html.match(/<dt[^>]*>[^<]*Traces[^<]*<\/dt>/)
    expect(dtMatch).not.toBeNull()
    expect(dtMatch![0]).toContain('border-b')
  })
})

// ---------------------------------------------------------------------------
// actionErrorMessage — daemon-down error mapping
// ---------------------------------------------------------------------------

describe('actionErrorMessage', () => {
  it('maps ApiError unreachable to the start-the-server remedy copy', () => {
    const msg = actionErrorMessage(new ApiError('POST /api/actions → 503', 'unreachable', 503))
    expect(msg).toContain('reach the dashboard server')
    expect(msg).toContain('mars ui')
  })

  it('maps ApiError stale-daemon to the daemon-restart remedy copy', () => {
    const msg = actionErrorMessage(new ApiError('POST /api/actions → 404', 'stale-daemon', 404))
    expect(msg).toContain('stale port')
    expect(msg).toContain('mars daemon restart')
  })

  it('renders a calm headline for non-ApiError errors (no raw message leak in prod)', () => {
    const msg = actionErrorMessage(new Error('generic network error'))
    expect(msg).toContain("Couldn't load the action")
    expect(msg).not.toContain('generic network error')
  })
})
