import { describe, expect, it } from 'vitest'
import { buildSituationReport } from '../situation-report'

describe('buildSituationReport', () => {
  it('summarises the current task, worker, and attention state without a provider', async () => {
    const report = await buildSituationReport({
      listTasks: async () => [
        { status: 'queued' },
        { status: 'running' },
        { status: 'blocked' },
        { status: 'failed' },
      ],
      getSemaphoreSnapshot: () => ({ inUse: 2, limit: 5 }),
      listActionQueue: async () => [{}, {}],
    })

    expect(report).toBe(
      'Situation: 1 queued task, 1 running task, 1 blocked task, and 1 failed task. Workers: 2 of 5 active. 2 items need attention.',
    )
  })

  it('does not count draft-proposal rows in the attention count', async () => {
    const report = await buildSituationReport({
      listTasks: async () => [],
      getSemaphoreSnapshot: () => ({ inUse: 0, limit: 0 }),
      listActionQueue: async () => [
        { kind: 'failed' },
        { kind: 'draft-proposal' },
        { kind: 'draft-proposal' },
        { kind: 'stale-queued' },
      ],
    })

    expect(report).toContain('2 items need attention.')
    expect(report).not.toContain('4 items')
  })
})
