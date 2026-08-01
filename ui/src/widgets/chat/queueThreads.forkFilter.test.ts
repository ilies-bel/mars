import { describe, expect, it } from 'vitest'
import type { ChatThread } from '@/shared/schemas'
import { filterThreadsByFork } from './queueThreads'

const thread = (id: string, parentThreadId: string | null): ChatThread => ({
  id,
  title: id,
  status: 'idle',
  attentionStatus: 'idle',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  parentThreadId,
} as ChatThread)

describe('filterThreadsByFork', () => {
  const threads = [
    thread('parent-a', null),
    thread('fork-a', 'parent-a'),
    thread('parent-b', null),
    thread('fork-b', 'parent-b'),
  ]

  it('shows all forked threads when the Forked only toggle is enabled', () => {
    expect(filterThreadsByFork(threads, { hasParent: true }).map((item) => item.id)).toEqual([
      'fork-a',
      'fork-b',
    ])
  })

  it('shows only the selected thread’s direct forks for the Forks of this thread chip', () => {
    expect(filterThreadsByFork(threads, { parentThreadId: 'parent-a' }).map((item) => item.id)).toEqual([
      'fork-a',
    ])
  })
})
