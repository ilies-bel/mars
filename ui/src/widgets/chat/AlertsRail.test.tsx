// @vitest-environment happy-dom
/**
 * The rail that replaced the main thread at the top of the Chat sidebar.
 *
 * Its whole reason to exist is that the operator sees what needs them without
 * leaving Chat, so the two things that matter are: it never claims all is clear
 * when it cannot read the queue, and clicking a row hands the item back.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AlertsRail } from './AlertsRail'
import type { ActionQueueItem } from '@/shared/schemas'

const mockItems = vi.hoisted(() => vi.fn<[], ActionQueueItem[]>(() => []))
const mockHealth = vi.hoisted(() => vi.fn(() => ({ isDown: false })))

vi.mock('@/entities/actionQueue/useActionQueue', () => ({
  useActionQueue: () => ({ items: mockItems(), error: null }),
}))
vi.mock('@/entities/daemon/useDaemonHealth', () => ({
  useDaemonHealth: () => mockHealth(),
}))

const item = (over: Partial<ActionQueueItem>): ActionQueueItem =>
  ({
    id: 'q1',
    kind: 'gate-broken',
    entityId: 'mars-abc12345',
    priority: 'high',
    title: 'gate broken',
    body: '',
    at: new Date().toISOString(),
    humanSummary: 'A verify gate keeps failing',
    verbs: [],
    decisions: [],
    actions: [],
    dag: null,
    ...over,
  }) as unknown as ActionQueueItem

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mockItems.mockReturnValue([])
  mockHealth.mockReturnValue({ isDown: false })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const render = async (onOpen = () => {}): Promise<void> => {
  await act(async () => {
    root.render(<AlertsRail onOpen={onOpen} />)
  })
}

describe('AlertsRail', () => {
  it('hands the clicked item back to its caller', async () => {
    const onOpen = vi.fn()
    mockItems.mockReturnValue([item({ id: 'q7' })])
    await render(onOpen)
    const row = container.querySelector<HTMLButtonElement>('[data-testid="alerts-rail-item"]')
    expect(row).not.toBeNull()
    await act(async () => { row!.click() })
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'q7' }))
  })

  it('excludes draft proposals — a shaped-idea backlog is not an alert', async () => {
    mockItems.mockReturnValue([
      item({ id: 'a', kind: 'failed' }),
      item({ id: 'b', kind: 'draft-proposal' }),
    ])
    await render()
    const rows = container.querySelectorAll('[data-testid="alerts-rail-item"]')
    expect(rows.length).toBe(1)
    expect(rows[0].getAttribute('data-item-id')).toBe('a')
  })

  it('says nothing needs you only when the daemon actually answered', async () => {
    await render()
    expect(container.querySelector('[data-testid="alerts-rail-empty"]')).not.toBeNull()
  })

  it('does not claim all clear when the daemon is unreachable', async () => {
    // An empty queue and an unreadable one are the same value here; saying
    // "nothing needs you" over a dead daemon is the worst possible moment.
    mockHealth.mockReturnValue({ isDown: true })
    await render()
    expect(container.querySelector('[data-testid="alerts-rail-empty"]')).toBeNull()
    expect(container.querySelector('[data-testid="alerts-rail-unreachable"]')).not.toBeNull()
  })

  it('disables the row whose thread is being resolved', async () => {
    mockItems.mockReturnValue([item({ id: 'q7' })])
    await act(async () => {
      root.render(<AlertsRail onOpen={() => {}} pendingItemId="q7" />)
    })
    const row = container.querySelector<HTMLButtonElement>('[data-testid="alerts-rail-item"]')
    expect(row!.disabled).toBe(true)
  })
})
