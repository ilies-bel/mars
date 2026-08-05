import { describe, expect, it } from 'vitest'
import { makeFakeDaemon, runCommandInProcess } from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'

describe('mars task stop', () => {
  it('stops multiple in-flight tasks in order and preserves the continue path', async () => {
    const daemon = makeFakeDaemon()

    const result = await runCommandInProcess(['task', 'stop', 'mars-one', 'mars-two'], {
      daemon,
      store: {} as DomainTaskStore,
      ctx: {} as OrchestratorContext,
    })

    expect(result.code).toBe(0)
    expect(daemon.calls).toEqual([
      { op: 'stop-task', id: 'mars-one' },
      { op: 'stop-task', id: 'mars-two' },
    ])
    expect(result.out.join('\n')).toContain("mars continue mars-one")
  })

  it('stops at the first daemon error', async () => {
    const daemon = makeFakeDaemon((req) => {
      if (req.op === 'stop-task' && req.id === 'mars-two') {
        throw new Error('task mars-two is not in flight')
      }
      return {}
    })

    const result = await runCommandInProcess(['task', 'stop', 'mars-one', 'mars-two', 'mars-three'], {
      daemon,
      store: {} as DomainTaskStore,
      ctx: {} as OrchestratorContext,
    })

    expect(result.code).toBe(1)
    expect(daemon.calls).toEqual([
      { op: 'stop-task', id: 'mars-one' },
      { op: 'stop-task', id: 'mars-two' },
    ])
    expect(result.err).toEqual(['mars-two: task mars-two is not in flight'])
  })
})
