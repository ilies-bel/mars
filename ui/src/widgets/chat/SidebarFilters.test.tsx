// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SidebarFilters, type SidebarFiltersValue } from './SidebarFilters'
import { filterSidebarThreads, type ThreadListFilters } from './queueThreads'
import type { ChatThread } from '@/shared/schemas'
import { ThreadSidebar } from '@/pages/ChatPage'

const filters: SidebarFiltersValue = {
  query: '',
  origin: 'all',
  selectedItem: null,
}

const thread = (overrides: Partial<ChatThread>): ChatThread => ({
  id: 'thread-1',
  title: 'Restart the failed deploy',
  status: 'idle',
  origin: 'alert',
  alertItemId: 'mars-123',
  alertResolved: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
} as ChatThread)

describe('SidebarFilters', () => {
  it('reports a typed search query so the open thread list narrows immediately', () => {
    const onChange = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(<SidebarFilters value={filters} onChange={onChange} onFastAction={() => {}} />)
    })

    const input = container.querySelector<HTMLInputElement>('[data-testid="thread-search"]')!
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(input, 'deploy')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith({ ...filters, query: 'deploy' })
    root.unmount()
  })

  it('narrows the rendered open thread list as the operator types', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    queryClient.setQueryData(['chat-threads', undefined], [
      thread({ id: 'deploy', title: 'Restart failed deploy' }),
      thread({ id: 'proposal', title: 'Review design proposal', origin: null, alertItemId: null }),
      thread({ id: 'resolved', title: 'Old deploy', alertResolved: true }),
    ])
    queryClient.setQueryData(['chat-history', undefined], [])
    const container = document.createElement('div')
    const root = createRoot(container)

    const SidebarHarness = () => {
      const [value, setValue] = useState<ThreadListFilters>({ query: '', origin: 'all' })
      return (
        <ThreadSidebar
          selectedId={null}
          onSelect={() => {}}
          filters={value}
          onFiltersChange={setValue}
          selectedItem={null}
          onFastAction={() => {}}
        />
      )
    }

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarHarness />
        </QueryClientProvider>,
      )
    })

    expect(container.textContent).toContain('Restart failed deploy')
    expect(container.textContent).toContain('Review design proposal')
    expect(container.textContent).not.toContain('Old deploy')

    const input = container.querySelector<HTMLInputElement>('[data-testid="thread-search"]')!
    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(input, 'deploy')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.textContent).toContain('Restart failed deploy')
    expect(container.textContent).not.toContain('Review design proposal')
    root.unmount()
  })

  it('lets operators scope the list by thread origin', () => {
    const onChange = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(<SidebarFilters value={filters} onChange={onChange} onFastAction={() => {}} />)
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="sidebar-filter-alerts"]')!.click()
    })

    expect(onChange).toHaveBeenCalledWith({ ...filters, origin: 'alerts' })
    root.unmount()
  })

  it('offers Restart selected only when the selected thread has a restartable queue item', () => {
    const onFastAction = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <SidebarFilters
          value={{
            ...filters,
            query: 'unrelated search',
            selectedItem: {
              id: 'mars-123',
              kind: 'failed',
              entityId: 'mars-123',
              priority: 'high',
              title: 'Deploy failed',
              body: 'The deploy stopped.',
              at: '2026-01-01T00:00:00.000Z',
              dag: null,
              errorKind: 'failed-task',
              actions: [{ id: 'restart', label: 'Restart', op: 'restart' }],
              diagnosis: null,
            } as SidebarFiltersValue['selectedItem'],
          }}
          onChange={() => {}}
          onFastAction={onFastAction}
        />,
      )
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="restart-selected"]')!.click()
    })

    expect(onFastAction).toHaveBeenCalledWith('restart')
    root.unmount()
  })

  it('filters open threads by query and origin together', () => {
    const threads = [
      thread({ id: 'failed', title: 'Restart deploy', alertItemId: 'mars-1' }),
      thread({ id: 'draft', title: 'Review proposal', alertItemId: 'proposal-1' }),
      thread({ id: 'operator', title: 'Discuss deploy', origin: null, alertItemId: null }),
      thread({ id: 'resolved', title: 'Restart deploy', alertResolved: true }),
    ]

    expect(
      filterSidebarThreads(threads, { query: 'deploy', origin: 'alerts' })
        .map((item) => item.id),
    ).toEqual(['failed'])
  })
})
