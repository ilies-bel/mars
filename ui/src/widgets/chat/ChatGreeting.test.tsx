// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatGreeting } from './ChatGreeting'
import type { OpenWorkItem } from './openWork'
import type { ActionQueueItem, DraftFeature } from '@/shared/schemas'
import type { UITask } from '@/shared/types'

const alert = (id: string, title: string): ActionQueueItem => ({
  id,
  entityId: id,
  kind: 'failed-task',
  priority: 'high',
  title,
  body: '',
  at: '2026-01-01T00:00:00.000Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [],
  diagnosis: null,
  resolution: null,
  humanSummary: '',
  verbs: [],
  decisions: [],
})

const blockedTask = (id: string, title: string): UITask => ({
  id,
  title,
  status: 'blocked',
  priority: 2,
  role: 'orchestrator',
  failed: false,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  spec: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const proposal = (id: string): DraftFeature => ({
  id,
  title: `Proposal ${id}`,
  problem: '',
  solution: '',
  status: 'draft',
  source: 'human',
  createdAt: 1,
  updatedAt: 1,
  acceptanceCount: 0,
  userStories: [],
})

const openWork: OpenWorkItem[] = [
  { source: 'alert', id: 'alert-1', item: alert('alert-1', 'Repair deployment'), priority: 3, at: '2026-01-02T00:00:00.000Z' },
  { source: 'blocked-task', id: 'task-1', task: blockedTask('task-1', 'Release is blocked'), priority: 2, at: '2026-01-01T00:00:00.000Z' },
]

describe('ChatGreeting', () => {
  it('names only the highest-ranked open-work item and reports every remaining open item', () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ChatGreeting rankedOpenWork={openWork} proposals={[proposal('1'), proposal('2')]} onOpenWork={() => {}} onShowRail={() => {}} />,
      )
    })

    expect(container.textContent).toContain('Repair deployment')
    expect(container.textContent).not.toContain('Release is blocked')
    expect(container.textContent).not.toContain('Proposal 1')
    expect(container.querySelectorAll('[data-testid="chat-greeting-next-move"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="chat-greeting-remaining"]')?.textContent).toContain('3 more')

    act(() => root.unmount())
  })

  it('opens its named item and sends remaining work to the context rail', () => {
    const onOpenWork = vi.fn()
    const onShowRail = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ChatGreeting rankedOpenWork={openWork} proposals={[]} onOpenWork={onOpenWork} onShowRail={onShowRail} />,
      )
    })

    act(() => (container.querySelector('[data-testid="chat-greeting-next-move"]') as HTMLButtonElement).click())
    expect(onOpenWork).toHaveBeenCalledWith(openWork[0])

    act(() => (container.querySelector('[data-testid="chat-greeting-remaining"]') as HTMLButtonElement).click())
    expect(onShowRail).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
  })
})
