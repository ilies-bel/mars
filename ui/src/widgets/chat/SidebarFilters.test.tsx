// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SidebarFilters, type SidebarFiltersValue } from './SidebarFilters'
import { filterSidebarThreads } from './queueThreads'
import type { ChatThread } from '@/shared/schemas'

const filters: SidebarFiltersValue = {
  query: '',
  kind: 'all',
  origin: 'all',
  selectedItem: null,
}

const thread = (overrides: Partial<ChatThread>): ChatThread => ({
  id: 'thread-1',
  title: 'Restart the failed deploy',
  status: 'idle',
  origin: 'alert',
  alertItemId: 'failed-task:mars-123',
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

  it('lets operators scope the list by failure kind and thread origin', () => {
    const onChange = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(<SidebarFilters value={filters} onChange={onChange} onFastAction={() => {}} />)
    })

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="sidebar-filter-failed-task"]')!.click()
      container.querySelector<HTMLButtonElement>('[data-testid="sidebar-filter-alerts"]')!.click()
    })

    expect(onChange).toHaveBeenNthCalledWith(1, { ...filters, kind: 'failed-task' })
    expect(onChange).toHaveBeenNthCalledWith(2, { ...filters, origin: 'alerts' })
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
              id: 'failed-task:mars-123',
              kind: 'failed-task',
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

  it('filters open threads by query, kind, and origin together', () => {
    const threads = [
      thread({ id: 'failed', title: 'Restart deploy', alertItemId: 'failed-task:mars-1' }),
      thread({ id: 'draft', title: 'Review proposal', alertItemId: 'draft-proposal:proposal-1' }),
      thread({ id: 'operator', title: 'Discuss deploy', origin: null, alertItemId: null }),
      thread({ id: 'resolved', title: 'Restart deploy', alertResolved: true }),
    ]

    expect(
      filterSidebarThreads(threads, { query: 'deploy', kind: 'failed-task', origin: 'alerts' })
        .map((item) => item.id),
    ).toEqual(['failed'])
  })
})
