// @vitest-environment happy-dom
/**
 * useKpiArcs must not request an arc breakdown for a KPI that has none.
 *
 * `cost-per-merged-task` is measured per merged task per day, and the daemon
 * answers `/kpis/cost-per-merged-task/arcs` with 400 "Unknown KPI key".
 * KpiDetailPage calls this hook before its early return for that key — hooks
 * cannot be conditional — so every visit to the cost detail page fired a
 * request guaranteed to fail, and threw the result away on the next line.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useKpiArcs } from './useKpiArcs'
import type { KpiKey } from '@/shared/schemas'

const mockFetchKpiArcs = vi.hoisted(() => vi.fn().mockResolvedValue({ arcs: [] }))

vi.mock('@/shared/api', () => ({ fetchKpiArcs: mockFetchKpiArcs }))

vi.mock('@/shared/useFocusedProject', () => ({
  useFocusedProject: () => ({
    projects: [{ projectId: 'p_test', repoRoot: '/repo', name: 'repo', health: 'live' }],
    focusedProjectId: 'p_test',
    setFocusedProjectId: () => {},
    projectsSettled: true,
    projectsError: null,
  }),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockFetchKpiArcs.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const renderForKey = async (key: KpiKey): Promise<void> => {
  const Probe = () => {
    useKpiArcs(key)
    return null
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('useKpiArcs', () => {
  it('fetches arcs for an arc-scoped KPI', async () => {
    await renderForKey('failure_rate')
    expect(mockFetchKpiArcs).toHaveBeenCalledWith('failure_rate', 'p_test')
  })

  it('does not fetch arcs for cost-per-merged-task', async () => {
    await renderForKey('cost-per-merged-task')
    expect(mockFetchKpiArcs).not.toHaveBeenCalled()
  })
})
