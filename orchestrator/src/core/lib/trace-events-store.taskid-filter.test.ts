import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openTraceEventStore } from './trace-events-store'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-trace-taskid-'))
  return join(dir, 'mars.db')
}

describe('trace-events-store taskId filter', () => {
  it('taskId-only filter returns only spans stamped with that taskId', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    await store.record({
      kind: 'step_started',
      taskId: 'task-A',
      originId: 'origin-X',
      payload: { stepName: 'code', workflowInstanceId: 'wf-1' },
    })
    await store.record({
      kind: 'step_started',
      taskId: 'task-B',
      originId: 'origin-X',
      payload: { stepName: 'verify', workflowInstanceId: 'wf-2' },
    })

    const results = await store.query({ taskId: 'task-A', kind: ['step_started'] })

    expect(results).toHaveLength(1)
    expect(results[0].taskId).toBe('task-A')
    expect(results[0].payload.stepName).toBe('code')

    await store.close()
  })

  it('originId-only filter returns all spans for that originId regardless of taskId', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    await store.record({
      kind: 'step_started',
      taskId: 'task-A',
      originId: 'origin-X',
      payload: { stepName: 'code', workflowInstanceId: 'wf-1' },
    })
    await store.record({
      kind: 'step_started',
      taskId: 'task-B',
      originId: 'origin-X',
      payload: { stepName: 'verify', workflowInstanceId: 'wf-2' },
    })
    await store.record({
      kind: 'step_started',
      taskId: 'task-C',
      originId: 'origin-Y',
      payload: { stepName: 'merge', workflowInstanceId: 'wf-3' },
    })

    const results = await store.query({ originId: 'origin-X', kind: ['step_started'] })

    expect(results).toHaveLength(2)
    expect(results.map((r) => r.taskId).sort()).toEqual(['task-A', 'task-B'])

    await store.close()
  })

  it('both taskId and originId supplied narrows results to spans matching both', async () => {
    const store = await openTraceEventStore(tmpDbPath())

    // task-A belongs to origin-X
    await store.record({
      kind: 'step_started',
      taskId: 'task-A',
      originId: 'origin-X',
      payload: { stepName: 'code', workflowInstanceId: 'wf-1' },
    })
    // task-B also belongs to origin-X (should be excluded by taskId filter)
    await store.record({
      kind: 'step_started',
      taskId: 'task-B',
      originId: 'origin-X',
      payload: { stepName: 'verify', workflowInstanceId: 'wf-2' },
    })
    // task-A also belongs to origin-Y (should be excluded by originId filter)
    await store.record({
      kind: 'step_started',
      taskId: 'task-A',
      originId: 'origin-Y',
      payload: { stepName: 'setup', workflowInstanceId: 'wf-3' },
    })

    const results = await store.query({
      taskId: 'task-A',
      originId: 'origin-X',
      kind: ['step_started'],
    })

    expect(results).toHaveLength(1)
    expect(results[0].taskId).toBe('task-A')
    expect(results[0].originId).toBe('origin-X')
    expect(results[0].payload.stepName).toBe('code')

    await store.close()
  })
})
