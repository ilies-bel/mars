import { describe, expect, it } from 'vitest'
import { type Task } from '../../queue'
import { pickWorkflowFor } from '../server'

const taskWithSpec = (spec: Task['spec']): Task => ({ spec } as Task)
const nonCoordinatorSpec: Task['spec'] = {
  files: [],
  verifyCmd: null,
  doneCriteria: [],
  taskType: 'auto',
}

describe('pickWorkflowFor', () => {
  it('routes coordinator tasks to the coordinator workflow', () => {
    expect(
      pickWorkflowFor(taskWithSpec({
        files: [],
        verifyCmd: null,
        doneCriteria: [],
        taskType: 'auto',
        executionMode: 'coordinated',
      })),
    ).toBe('coordinator')
  })

  it.each([null, nonCoordinatorSpec])(
    'routes tasks without coordinator execution mode to the implement workflow',
    (spec) => {
      expect(pickWorkflowFor(taskWithSpec(spec))).toBe('implement')
    },
  )
})
