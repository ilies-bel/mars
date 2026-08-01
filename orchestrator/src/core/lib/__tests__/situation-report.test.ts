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
})
