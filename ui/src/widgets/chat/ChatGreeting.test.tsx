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

const manyOpenWork: OpenWorkItem[] = [
  ...openWork,
  { source: 'alert', id: 'alert-2', item: alert('alert-2', 'Rebuild index'), priority: 2, at: '2026-01-01T00:00:00.000Z' },
  { source: 'alert', id: 'alert-3', item: alert('alert-3', 'Rotate credentials'), priority: 1, at: '2026-01-01T00:00:00.000Z' },
  { source: 'alert', id: 'alert-4', item: alert('alert-4', 'Prune worktrees'), priority: 1, at: '2026-01-01T00:00:00.000Z' },
]

describe('ChatGreeting', () => {
  it('briefs the operator in prose: how many subjects, where to start and why', () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ChatGreeting
          rankedOpenWork={openWork}
          proposals={[proposal('1'), proposal('2'), { ...proposal('sliced'), status: 'sliced' }]}
          onOpenWork={() => {}}
          onShowRail={() => {}}
        />,
      )
    })

    expect(container.textContent).toContain('2 subjects need you.')
    expect(container.textContent).toContain('Start with Repair deployment \u2014 it failed and needs a decision.')
    expect(container.textContent).toContain('After that, Release is blocked.')
    expect(container.textContent).toContain('2 drafts are also waiting to be shaped.')
    expect(container.textContent).not.toContain('Proposal 1')
    expect(container.querySelectorAll('[data-testid="chat-greeting-next-move"]')).toHaveLength(1)
    // Everything named inline, so nothing is deferred to Context.
    expect(container.querySelector('[data-testid="chat-greeting-remaining"]')).toBeNull()

    act(() => root.unmount())
  })

  it('names a blocked task with its own reason rather than the failure phrasing', () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ChatGreeting rankedOpenWork={[openWork[1]!]} proposals={[]} onOpenWork={() => {}} onShowRail={() => {}} />,
      )
    })

    expect(container.textContent).toBe(
      "One subject needs you. Start with Release is blocked \u2014 it's blocked and can't move on its own.",
    )

    act(() => root.unmount())
  })

  it('names two follow-ups and defers the tail to Context', () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ChatGreeting rankedOpenWork={manyOpenWork} proposals={[]} onOpenWork={() => {}} onShowRail={() => {}} />,
      )
    })

    expect(container.textContent).toContain('5 subjects need you.')
    expect(container.textContent).toContain('After that, Release is blocked and Rebuild index')
    expect(container.textContent).toContain('2 more open items in Context.')
    expect(container.textContent).not.toContain('Rotate credentials')

    act(() => root.unmount())
  })

  it('opens any named subject and sends the unnamed tail to the context rail', () => {
    const onOpenWork = vi.fn()
    const onShowRail = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ChatGreeting rankedOpenWork={manyOpenWork} proposals={[]} onOpenWork={onOpenWork} onShowRail={onShowRail} />,
      )
    })

    act(() => (container.querySelector('[data-testid="chat-greeting-next-move"]') as HTMLButtonElement).click())
    expect(onOpenWork).toHaveBeenCalledWith(manyOpenWork[0])

    act(() => (container.querySelector('[data-testid="chat-greeting-follow-up-alert-2"]') as HTMLButtonElement).click())
    expect(onOpenWork).toHaveBeenCalledWith(manyOpenWork[2])

    act(() => (container.querySelector('[data-testid="chat-greeting-remaining"]') as HTMLButtonElement).click())
    expect(onShowRail).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
  })

  it('offers exactly one Grill response for a supplied draft and opens one of those drafts', () => {
    const onOpenProposal = vi.fn()
    const drafts = [proposal('1'), proposal('2')]
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ChatGreeting
          rankedOpenWork={[]}
          proposals={drafts}
          onOpenWork={() => {}}
          onShowRail={() => {}}
          onOpenProposal={onOpenProposal}
        />,
      )
    })

    expect(container.textContent).toContain('Nothing is failing or blocked right now.')
    expect(container.textContent).toContain('2 drafts are waiting to be shaped')
    expect(container.querySelectorAll('[data-testid^="preloaded-response-"]')).toHaveLength(1)
    expect(container.textContent).toContain('Grill:')
    act(() => (container.querySelector('[data-testid^="preloaded-response-"]') as HTMLButtonElement).click())
    expect(onOpenProposal).toHaveBeenCalledTimes(1)
    expect(drafts).toContain(onOpenProposal.mock.calls[0]?.[0])

    act(() => root.unmount())
  })

  it('recomputes the offered response from drafts that remain', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const onOpenProposal = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ChatGreeting rankedOpenWork={[]} proposals={[proposal('1'), proposal('2')]} onOpenWork={() => {}} onShowRail={() => {}} onOpenProposal={onOpenProposal} />,
      )
    })
    act(() => {
      root.render(
        <ChatGreeting rankedOpenWork={[]} proposals={[proposal('2')]} onOpenWork={() => {}} onShowRail={() => {}} onOpenProposal={onOpenProposal} />,
      )
    })

    act(() => (container.querySelector('[data-testid^="preloaded-response-"]') as HTMLButtonElement).click())
    expect(onOpenProposal).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }))

    random.mockRestore()
    act(() => root.unmount())
  })

  it('renders only the all-clear sentence when no work or drafts remain', () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(<ChatGreeting rankedOpenWork={[]} proposals={[]} onOpenWork={() => {}} onShowRail={() => {}} />)
    })

    expect(container.textContent).toBe('All clear \u2014 nothing needs you right now.')
    expect(container.querySelector('[data-testid="preloaded-responses"]')).toBeNull()
    act(() => root.unmount())
  })
})
