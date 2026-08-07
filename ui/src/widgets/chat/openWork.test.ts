import { describe, expect, it } from 'vitest'
import { buildRankedOpenWork } from './openWork'
import type { ActionQueueItem } from '@/shared/schemas'
import type { UITask } from '@/shared/types'

const alert = (overrides: Partial<ActionQueueItem> = {}): ActionQueueItem => ({
  id: 'alert-1',
  entityId: 'task-alert',
  kind: 'failed-task',
  priority: 'normal',
  title: 'A worker needs attention',
  body: '',
  at: '2026-01-02T00:00:00.000Z',
  dag: null,
  errorKind: 'failed-task',
  actions: [],
  diagnosis: null,
  humanSummary: '',
  verbs: [],
  decisions: [],
  ...overrides,
} as ActionQueueItem)

const blockedTask = (overrides: Partial<UITask> = {}): UITask => ({
  id: 'task-blocked',
  title: 'Deploy waits for the build',
  status: 'blocked',
  priority: 2,
  role: 'orchestrator',
  failed: false,
  dropReason: null,
  recoverySpawnedCount: 0,
  blockerTaskId: null,
  spec: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  ...overrides,
})

describe('buildRankedOpenWork', () => {
  it('shows unresolved alerts and blocked tasks once, in shared priority then recency order', () => {
    const result = buildRankedOpenWork(
      [
        alert({ id: 'resolved', entityId: 'resolved-task', priority: 'high', resolution: { resolvedAt: '2026-01-04T00:00:00.000Z', resolution: 'done', resolutionNote: null, rootCause: null, resolvedBy: null } }),
        alert({ id: 'proposal', entityId: 'proposal-1', kind: 'draft-proposal', priority: 'high' }),
        alert({ id: 'normal-newer', entityId: 'alert-normal', priority: 'normal', at: '2026-01-05T00:00:00.000Z' }),
        alert({ id: 'high-older', entityId: 'alert-high', priority: 'high', at: '2026-01-01T00:00:00.000Z' }),
        alert({ id: 'represented', entityId: 'task-duplicate', priority: 'low' }),
      ],
      [
        blockedTask({ id: 'task-blocked', priority: 2, updatedAt: '2026-01-03T00:00:00.000Z' }),
        blockedTask({ id: 'task-duplicate', priority: 3 }),
      ],
    )

    expect(result.map((item) => [item.source, item.id])).toEqual([
      ['alert', 'high-older'],
      ['alert', 'normal-newer'],
      ['blocked-task', 'task-blocked'],
      ['alert', 'represented'],
    ])
    expect(result.find((item) => item.id === 'task-blocked')).toMatchObject({
      source: 'blocked-task',
      priority: 2,
      at: '2026-01-03T00:00:00.000Z',
    })
  })
})
