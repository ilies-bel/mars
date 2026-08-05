// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextRail } from './ContextRail'
import { buildRankedOpenWork } from './openWork'
import type { ActionQueueItem, DraftFeature } from '@/shared/schemas'
import type { UITask } from '@/shared/types'

const state = vi.hoisted(() => ({
  items: [] as ActionQueueItem[],
  adrs: [] as Array<{ number: number; title: string; slug: string }>,
  queueError: null as Error | null,
  adrsError: null as Error | null,
  blockedTasks: [] as UITask[],
  proposals: [] as DraftFeature[],
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({
    data: options.queryKey[0] === 'adrs' ? state.adrs : undefined,
    error: state.adrsError,
  }),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}))

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: state.items, error: state.queueError, projectsError: null, projectsEmpty: false }),
}))

vi.mock('@/entities/actionQueue/useActionQueueHistory', () => ({
  useActionQueueHistory: () => ({
    items: [], nextCursor: null, isLoadingMore: false, loadMore: () => {},
    error: null, projectsError: null, projectsEmpty: false,
  }),
}))

vi.mock('@/hooks/useProgress', () => ({
  useProgress: () => ({
    tasks: null, proposals: [],
    byCluster: { Queued: [], 'In progress': [], Blocked: [], Failed: [], Done: [] },
    aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 }, error: null, connected: false,
  }),
}))

const alert = (id: string): ActionQueueItem => ({
  id,
  entityId: id,
  kind: 'failed-task',
  priority: 'high',
  title: `Alert ${id}`,
  body: '',
  at: `2026-01-0${id}T00:00:00.000Z`,
  dag: null,
  errorKind: 'failed-task',
  actions: [],
  diagnosis: null,
  resolution: null,
  humanSummary: '',
  verbs: [],
  decisions: [],
})

const blockedTask = (id: string): UITask => ({
  id,
  title: `Blocked ${id}`,
  status: 'blocked',
  priority: 2,
  role: 'orchestrator',
  failed: false,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  spec: null,
  createdAt: `2026-01-0${id}T00:00:00.000Z`,
  updatedAt: `2026-01-0${id}T00:00:00.000Z`,
})

const proposal = (id: string, updatedAt: number): DraftFeature => ({
  id,
  title: `Proposal ${id}`,
  problem: '',
  solution: '',
  status: 'draft',
  source: 'human',
  createdAt: updatedAt,
  updatedAt,
  acceptanceCount: 0,
  userStories: [],
})

const rail = (
  onOpenWork?: (item: ReturnType<typeof buildRankedOpenWork>[number]) => void,
  onOpenProposal?: (proposal: DraftFeature) => void,
) => (
  <ContextRail
    openWork={buildRankedOpenWork(state.items, state.blockedTasks)}
    onOpenWork={onOpenWork}
    proposals={state.proposals}
    onOpenProposal={onOpenProposal}
  />
)

describe('ContextRail piles', () => {
  it('shows the three most recently updated draft proposals', async () => {
    state.proposals = [
      proposal('old', 1),
      proposal('newest', 4),
      proposal('middle', 2),
      proposal('newer', 3),
    ]
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    const rows = [...container.querySelectorAll('[data-testid="context-rail-proposal-row"]')]
    expect(rows.map((row) => row.textContent)).toEqual([
      'Proposal newest',
      'Proposal newer',
      'Proposal middle',
    ])
    await act(async () => root.unmount())
    state.proposals = []
  })

  it('shows only drafts and expands every proposal before showing less again', async () => {
    state.proposals = [
      proposal('one', 1), proposal('two', 2), proposal('three', 3), proposal('four', 4),
      { ...proposal('published', 5), status: 'accepted' },
    ]
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    const section = container.querySelector('section[aria-label="Proposals"]') as HTMLElement
    const toggle = section.querySelector('button[aria-expanded="false"]') as HTMLButtonElement
    expect(section.querySelectorAll('[data-testid="context-rail-proposal-row"]')).toHaveLength(3)
    expect(section.textContent).not.toContain('Proposal published')
    await act(async () => toggle.click())
    expect(section.querySelectorAll('[data-testid="context-rail-proposal-row"]')).toHaveLength(4)
    expect(toggle.textContent).toContain('Show less')
    await act(async () => toggle.click())
    expect(section.querySelectorAll('[data-testid="context-rail-proposal-row"]')).toHaveLength(3)
    await act(async () => root.unmount())
    state.proposals = []
  })

  it('renders an empty proposal state and forwards the selected draft', async () => {
    const onOpenProposal = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail(undefined, onOpenProposal))
    })
    expect(container.textContent).toContain('No proposals')

    const selected = proposal('open', 1)
    state.proposals = [selected]
    await act(async () => {
      root.render(rail(undefined, onOpenProposal))
    })
    await act(async () => (container.querySelector('[data-testid="context-rail-proposal-row"]') as HTMLButtonElement).click())
    expect(onOpenProposal).toHaveBeenCalledWith(selected)
    await act(async () => root.unmount())
    state.proposals = []
  })

  it('shows exactly three open alert rows by default', async () => {
    state.items = ['1', '2', '3', '4'].map(alert)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    expect(container.querySelectorAll('[data-testid="context-rail-alert-row"]')).toHaveLength(3)
    await act(async () => root.unmount())
  })

  it('expands all alerts and collapses back to three', async () => {
    state.items = ['1', '2', '3', '4', '5', '6', '7'].map(alert)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    const toggle = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement
    expect(toggle.textContent).toContain('See all 7')
    await act(async () => toggle.click())
    expect(container.querySelectorAll('[data-testid="context-rail-alert-row"]')).toHaveLength(7)
    expect(toggle.textContent).toContain('Show less')
    await act(async () => toggle.click())
    expect(container.querySelectorAll('[data-testid="context-rail-alert-row"]')).toHaveLength(3)
    await act(async () => root.unmount())
  })

  it('omits the alert toggle when there are at most three rows', async () => {
    state.items = ['1', '2', '3'].map(alert)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    expect(container.textContent).not.toContain('See all')
    await act(async () => root.unmount())
  })

  it('excludes proposal and resolved queue rows from alerts', async () => {
    const proposal = { ...alert('proposal'), kind: 'draft-proposal' } as ActionQueueItem
    const resolved = {
      ...alert('resolved'),
      resolution: {
        resolvedAt: '2026-01-01T00:00:00.000Z', resolution: 'done', resolutionNote: null,
        rootCause: null, resolvedBy: null,
      },
    }
    state.items = [alert('open'), proposal, resolved]
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    expect(container.textContent).toContain('Alert open')
    expect(container.textContent).not.toContain('Alert proposal')
    expect(container.textContent).not.toContain('Alert resolved')
    await act(async () => root.unmount())
  })

  it('renders an empty alert state without queue rows', async () => {
    state.items = []
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    expect(container.textContent).toContain('No alerts')
    await act(async () => root.unmount())
  })

  it('opens the selected work item through the supplied source-aware callback', async () => {
    const item = alert('open')
    const onOpenWork = vi.fn()
    state.items = [item]
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail(onOpenWork))
    })
    await act(async () => (container.querySelector('[data-testid="context-rail-alert-row"]') as HTMLButtonElement).click())

    expect(onOpenWork).toHaveBeenCalledWith(expect.objectContaining({ source: 'alert', item }))
    await act(async () => root.unmount())
  })

  it('includes blocked tasks without relabelling them as alerts and opens their detail callback', async () => {
    const onOpenWork = vi.fn()
    state.items = [alert('represented')]
    state.blockedTasks = [blockedTask('represented'), blockedTask('waiting')]
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail(onOpenWork))
    })

    expect(container.querySelectorAll('[data-testid="context-rail-alert-row"]')).toHaveLength(2)
    expect(container.textContent).toContain('Blocked waiting')
    expect(container.textContent).toContain('blocked')
    await act(async () => (container.querySelectorAll('[data-testid="context-rail-alert-row"]')[1] as HTMLButtonElement).click())
    expect(onOpenWork).toHaveBeenCalledWith(expect.objectContaining({ source: 'blocked-task', id: 'waiting' }))
    await act(async () => root.unmount())
    state.blockedTasks = []
  })

  it('shows the three newest ADRs with safe project ADR links', async () => {
    state.items = []
    state.adrs = [
      { number: 2, title: 'Two', slug: 'two' },
      { number: 7, title: 'Seven', slug: 'seven' },
      { number: 5, title: 'Five', slug: 'five' },
      { number: 3, title: 'Three', slug: 'three' },
    ]
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<ContextRail projectId="project-1" openWork={buildRankedOpenWork(state.items, state.blockedTasks)} />)
    })

    const rows = [...container.querySelectorAll('[data-testid="context-rail-adr-row"]')]
    expect(rows.map((row) => row.textContent)).toEqual(['ADR 7: Seven', 'ADR 5: Five', 'ADR 3: Three'])
    expect(rows[0].getAttribute('href')).toBe('/api/project/adrs/docs%2Fknowledge%2Fdecisions%2F0007-seven.md?project=project-1')
    await act(async () => root.unmount())
  })

  it('expands the ADR pile in place and collapses it back to the newest three', async () => {
    state.items = []
    state.adrs = [1, 2, 3, 4, 5, 6, 7].map((number) => ({
      number,
      title: `ADR ${number}`,
      slug: `adr-${number}`,
    }))
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    const section = container.querySelector('section[aria-label="ADRs"]') as HTMLElement
    const toggle = section.querySelector('button') as HTMLButtonElement
    expect(section.querySelectorAll('[data-testid="context-rail-adr-row"]')).toHaveLength(3)
    expect(toggle.textContent).toContain('See all 7')

    await act(async () => toggle.click())
    expect(section.querySelectorAll('[data-testid="context-rail-adr-row"]')).toHaveLength(7)
    expect(toggle.textContent).toContain('Show less')

    await act(async () => toggle.click())
    expect(section.querySelectorAll('[data-testid="context-rail-adr-row"]')).toHaveLength(3)
    await act(async () => root.unmount())
  })

  it('keeps the rail visible when action-queue and ADR queries fail', async () => {
    state.items = []
    state.adrs = []
    state.queueError = new Error('queue unavailable')
    state.adrsError = new Error('ADR unavailable')
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(rail())
    })

    expect(container.querySelector('[aria-label="Context rail"]')).not.toBeNull()
    await act(async () => root.unmount())
    state.queueError = null
    state.adrsError = null
  })
})
