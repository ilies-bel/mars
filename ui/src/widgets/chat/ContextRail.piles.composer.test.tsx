// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextRail } from './ContextRail'
import type { ActionQueueItem } from '@/shared/schemas'

const state = vi.hoisted(() => ({
  items: [] as ActionQueueItem[],
  adrs: [] as Array<{ number: number; title: string; slug: string }>,
  queueError: null as Error | null,
  adrsError: null as Error | null,
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

describe('ContextRail piles', () => {
  it('shows exactly three open alert rows by default', async () => {
    state.items = ['1', '2', '3', '4'].map(alert)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<ContextRail />)
    })

    expect(container.querySelectorAll('[data-testid="context-rail-alert-row"]')).toHaveLength(3)
    await act(async () => root.unmount())
  })

  it('expands all alerts and collapses back to three', async () => {
    state.items = ['1', '2', '3', '4', '5', '6', '7'].map(alert)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<ContextRail />)
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
      root.render(<ContextRail />)
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
      root.render(<ContextRail />)
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
      root.render(<ContextRail />)
    })

    expect(container.textContent).toContain('No alerts')
    await act(async () => root.unmount())
  })

  it('opens the selected alert Subject through the supplied callback', async () => {
    const item = alert('open')
    const onOpenAlert = vi.fn()
    state.items = [item]
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<ContextRail onOpenAlert={onOpenAlert} />)
    })
    await act(async () => (container.querySelector('[data-testid="context-rail-alert-row"]') as HTMLButtonElement).click())

    expect(onOpenAlert).toHaveBeenCalledWith(item)
    await act(async () => root.unmount())
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
      root.render(<ContextRail projectId="project-1" />)
    })

    const rows = [...container.querySelectorAll('[data-testid="context-rail-adr-row"]')]
    expect(rows.map((row) => row.textContent)).toEqual(['ADR 7: Seven', 'ADR 5: Five', 'ADR 3: Three'])
    expect(rows[0].getAttribute('href')).toBe('/api/project/adrs/docs%2Fadr%2F0007-seven.md?project=project-1')
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
      root.render(<ContextRail />)
    })

    expect(container.querySelector('[aria-label="Context rail"]')).not.toBeNull()
    await act(async () => root.unmount())
    state.queueError = null
    state.adrsError = null
  })
})
