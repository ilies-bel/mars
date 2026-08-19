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

// Rows are sorted priority-then-recency, so a shared wall-clock `at` would
// make row order a millisecond race between two `new Date()` calls. Fixtures
// state their own `at` whenever the test asserts on row position.
const NEWER = '2026-08-17T15:50:00.000Z'
const OLDER = '2026-08-17T15:40:00.000Z'

const item = (over: Partial<ActionQueueItem>): ActionQueueItem =>
  ({
    id: 'q1',
    kind: 'gate-broken',
    entityId: 'mars-abc12345',
    priority: 'high',
    title: 'gate broken',
    body: '',
    at: NEWER,
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

  it('renders the arc goal as the headline so failed rows are distinguishable', async () => {
    // The recipe generates the same humanSummary sentence for every failed
    // task ("A task got stuck and Mars used up its retry — ..."); arcGoal is
    // the one field that actually differs row to row.
    mockItems.mockReturnValue([
      item({
        id: 'a',
        at: NEWER,
        kind: 'failed',
        humanSummary: 'A task got stuck and Mars used up its retry — decide what to do (mars-a)',
        arcGoal: '# UI consistency drift: Steward contradicts itself\nsome detail',
      }),
      item({
        id: 'b',
        at: OLDER,
        kind: 'failed',
        humanSummary: 'A task got stuck and Mars used up its retry — decide what to do (mars-b)',
        arcGoal: '# Paused dispatch is invisible outside Control Room\nsome other detail',
      }),
    ])
    await render()
    const rows = container.querySelectorAll('[data-testid="alerts-rail-item"]')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('UI consistency drift')
    expect(rows[1].textContent).toContain('Paused dispatch is invisible')
    expect(rows[0].textContent).not.toBe(rows[1].textContent)
  })

  it('falls back to humanSummary, then title, when arcGoal is absent', async () => {
    mockItems.mockReturnValue([
      item({ id: 'a', at: NEWER, arcGoal: null, humanSummary: 'A verify gate keeps failing' }),
      item({ id: 'b', at: OLDER, arcGoal: null, humanSummary: '', title: 'fallback title' }),
    ])
    await render()
    const rows = container.querySelectorAll('[data-testid="alerts-rail-item"]')
    expect(rows[0].textContent).toContain('A verify gate keeps failing')
    expect(rows[1].textContent).toContain('fallback title')
  })

  it('shows the derived failure cause on the second line when a goal and detail are present', async () => {
    mockItems.mockReturnValue([
      item({
        id: 'a',
        kind: 'failed',
        arcGoal: '# Fix the thing',
        humanDetail: { failureSignature: 'verify/unclassified' } as ActionQueueItem['humanDetail'],
      }),
    ])
    await render()
    const row = container.querySelector('[data-testid="alerts-rail-item"]')
    expect(row!.textContent).toContain('verify failed')
  })
})
