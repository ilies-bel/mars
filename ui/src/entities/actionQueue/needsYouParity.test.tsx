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
 * a rendered TriagePage (via its mocked useActionQueue feed), a rendered
 * Shell (sidebar badge), and a rendered ChatGreeting (fed the computed count,
 * mirroring how the real data flow passes it down), and asserts they all
 * land on the identical integer. The chat situation card is not rendered
 * here (no UI component — it's server-rendered prose); it shares this same
 * `countNeedsYou` definition by construction, verified by the backend test.
 *
 * The first fixture (`sharedFixture`) is deliberately shaped to prove
 * clustering doesn't distort the count: 'awaiting-human' appears 9 times,
 * which is enough to collapse into ONE cluster row on the triage list
 * (CLUSTER_THRESHOLD=5) — the badge must still report all 9, not 1.
 * draft-proposal rows are excluded entirely. Every item in this fixture has
 * a distinct entityId, so it does NOT exercise entity dedup.
 *
 * The second fixture (`groupedFixture`) is the complementary case: ONE
 * entityId carrying three independently-derived condition rows (`failed` +
 * `recovery-abandoned` + `gate-broken`), the exact ADR-0057 shape that used
 * to inflate every surface's count to 3 for what is really one task needing
 * attention. Without this fixture, `sharedFixture` alone could pass even if
 * the entity dedup were missing from one of the four surfaces, since no
 * grouping ever occurs there.
 */

import { vi, describe, expect, it, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { countNeedsYou } from './clusterRows'
import { ChatGreeting } from '@/widgets/chat/ChatGreeting'
import { TriagePage } from '@/pages/TriagePage'
import { Shell } from '@/widgets/Shell'
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
// A second fixture: ONE task (shared entityId) holding three independently
// derived condition rows — the ADR-0057 scenario `countNeedsYou` must dedup
// rather than count as three separate subjects. Mirrors
// clusterRows.test.ts's `liveTripleForOneTask` and
// orchestrator/src/core/lib/__tests__/situation-report.test.ts's matching
// fixture. Without this fixture, a fixture where every item has a distinct
// entityId (like `sharedFixture` above) can never exercise the dedup path at
// all — every surface would "agree" by coincidence even if the dedup were
// silently missing from one of them.
// ---------------------------------------------------------------------------

const groupedFixture: ActionQueueItem[] = [
  { ...makeItem('failed', 'grp-failed'), entityId: 'mars-shared-001' },
  { ...makeItem('recovery-abandoned', 'grp-recovery'), entityId: 'mars-shared-001' },
  { ...makeItem('gate-broken', 'grp-gate'), entityId: 'mars-shared-001' },
]

const EXPECTED_GROUPED_NEEDS_YOU = 1

// The action-queue feed every surface below reads from. Mutable so different
// `it` blocks can swap fixtures; reset after each test so order never leaks.
let currentQueueItems: ActionQueueItem[] = sharedFixture
afterEach(() => {
  currentQueueItems = sharedFixture
})

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
  useActionQueue: () => ({ items: currentQueueItems, error: null }),
}))

// Shell mocks — same shape as Shell.test.tsx's renderToStaticMarkup setup.
vi.mock('@/widgets/ProjectSelector', () => ({
  ProjectSelector: () => null,
}))

vi.mock('@/entities/operator/useDispatchState', () => ({
  useDispatchState: () => ({ paused: false, reason: null, since: null, detail: null }),
  pauseReasonLabel: () => 'paused',
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

describe('needs-you count parity — one entityId, several condition rows, every surface agrees', () => {
  it('countNeedsYou dedups the three rows down to one subject', () => {
    expect(countNeedsYou(groupedFixture)).toBe(EXPECTED_GROUPED_NEEDS_YOU)
  })

  it('TriagePage header badge reports the deduped subject count', () => {
    currentQueueItems = groupedFixture
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<TriagePage />)
    })
    // needsYouCount === 1 uses the singular form ('item', not 'items').
    expect(container.querySelector('[aria-label="1 item needs attention"]')).not.toBeNull()
    act(() => root.unmount())
  })

  it('Shell sidebar badge reports the same deduped subject count', () => {
    currentQueueItems = groupedFixture
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(<Shell hash="#/chat">page</Shell>)
    })
    expect(
      container.querySelector(`[aria-label="${EXPECTED_GROUPED_NEEDS_YOU} decisions pending"]`),
    ).not.toBeNull()
    act(() => root.unmount())
  })

  it('ChatGreeting reports the same deduped subject count', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <ChatGreeting
          running={0}
          recovering={0}
          needYou={countNeedsYou(groupedFixture)}
          doneToday={0}
        />,
      )
    })
    expect(container.textContent).toContain(`${EXPECTED_GROUPED_NEEDS_YOU} need you`)
    act(() => root.unmount())
  })
})
