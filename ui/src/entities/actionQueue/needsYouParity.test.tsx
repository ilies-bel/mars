// @vitest-environment happy-dom
/**
 * Regression test for the "four different counts" bug: the triage badge,
 * the sidebar badge, the chat greeting, and the chat situation card each
 * used to compute "needs you" a different way and disagreed in a live
 * session (15 / 15 / 6 / 14 for the same state). All four now derive from
 * `countNeedsYou` — see orchestrator/src/core/lib/situation-report.ts for
 * the backend counterpart and its matching regression test.
 *
 * This file drives the SAME fixture through `countNeedsYou` directly, through
 * a rendered TriagePage (via its mocked useActionQueue feed), and through a
 * rendered ChatGreeting (fed the computed count, mirroring how the real data
 * flow passes it down), and asserts all three land on the identical integer.
 *
 * The fixture is deliberately shaped to prove clustering doesn't distort the
 * count: 'awaiting-human' appears 9 times, which is enough to collapse into
 * ONE cluster row on the triage list (CLUSTER_THRESHOLD=5) — the badge must
 * still report all 9, not 1. draft-proposal rows are excluded entirely.
 */

import { vi, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { countNeedsYou } from './clusterRows'
import { ChatGreeting } from '@/widgets/chat/ChatGreeting'
import { TriagePage } from '@/pages/TriagePage'
import type { ActionQueueItem } from '@/shared/schemas'

// ---------------------------------------------------------------------------
// The one shared fixture — mirrors
// orchestrator/src/core/lib/__tests__/situation-report.test.ts's sharedFixture
// ---------------------------------------------------------------------------

const makeItem = (kind: string, id: string): ActionQueueItem =>
  ({
    id,
    entityId: `entity-${id}`,
    kind,
    priority: 'normal' as const,
    title: `Title for ${id}`,
    body: '',
    at: '2026-01-01T00:00:00Z',
    dag: null,
    errorKind: kind,
    actions: [],
    decisions: [],
    humanSummary: `Summary for ${id}`,
    humanDetail: undefined,
    verbs: [],
    arcGoal: null,
    diagnosis: null,
    failureReasonCode: null,
    fixForTaskId: null,
    resolution: null,
    devServerUrl: null,
    snoozeUntil: undefined,
  }) as ActionQueueItem

const sharedFixture: ActionQueueItem[] = [
  ...Array.from({ length: 5 }, (_, i) => makeItem('failed', `failed-${i}`)),
  ...Array.from({ length: 9 }, (_, i) => makeItem('awaiting-human', `awaiting-${i}`)),
  ...Array.from({ length: 20 }, (_, i) => makeItem('draft-proposal', `draft-${i}`)),
]

const EXPECTED_NEEDS_YOU = 14

// ---------------------------------------------------------------------------
// TriagePage mocks — same shape as TriagePage.test.tsx
// ---------------------------------------------------------------------------

vi.mock('@/shared/api', () => ({
  invokeAction: vi.fn().mockResolvedValue(undefined),
  postDecision: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  createChatThread: vi.fn().mockResolvedValue({ id: 'thread-id' }),
}))

vi.mock('@/entities/alerts/api', () => ({
  startThreadFromAlert: vi.fn().mockResolvedValue({ threadId: 'thread-id' }),
}))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProjectId: () => null,
  // TriagePage reads the focused project's probed health so an unreadable
  // queue is never rendered as an empty one.
  useFocusedProject: () => ({
    projects: [
      { projectId: 'p_test', repoRoot: '/repo', name: 'repo', health: 'live' },
    ],
    focusedProjectId: 'p_test',
    setFocusedProjectId: () => {},
    projectsSettled: true,
    projectsError: null,
  }),
}))

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: sharedFixture, error: null }),
}))

vi.mock('@/entities/proposals/useProposals', () => ({
  useProposals: () => ({
    proposals: [],
    error: null,
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

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('@/shared/time', () => ({
  relativeTime: () => '1m ago',
}))

vi.mock('@/shared/alertCause', () => ({
  deriveCause: () => undefined,
}))

// ---------------------------------------------------------------------------
// Parity assertions
// ---------------------------------------------------------------------------

describe('needs-you count parity — one fixture, every surface agrees', () => {
  it('countNeedsYou computes the expected integer directly', () => {
    expect(countNeedsYou(sharedFixture)).toBe(EXPECTED_NEEDS_YOU)
  })

  it('TriagePage header badge shows the same integer, unaffected by clustering', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<TriagePage />)
    })
    expect(container.textContent).toContain(String(EXPECTED_NEEDS_YOU))
    // Old (buggy) behaviour rendered 7: 5 individual 'failed' rows + 1
    // 'awaiting-human' cluster row + 1 'draft-proposal' cluster row.
    expect(container.querySelector(`[aria-label="${EXPECTED_NEEDS_YOU} items need attention"]`)).not.toBeNull()
    act(() => root.unmount())
  })

  it('ChatGreeting renders the same integer when fed countNeedsYou(sharedFixture)', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <ChatGreeting
          running={0}
          recovering={0}
          needYou={countNeedsYou(sharedFixture)}
          doneToday={0}
        />,
      )
    })
    expect(container.textContent).toContain(`${EXPECTED_NEEDS_YOU} need you`)
    act(() => root.unmount())
  })
})
