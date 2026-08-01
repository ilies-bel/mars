import { describe, expect, it } from 'bun:test'
import { groupTasks } from './group'
import type { Task } from './types'

const makeTask = (
  overrides: Partial<Task> & { id: string; prompt: string; status: Task['status'] },
): Task => ({
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  retryCount: 0,
  priority: 2,
  blockerTaskId: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
})

describe('groupTasks – card title resolution', () => {
  it('gives a fix task the ORIGIN task title, not the recovery prompt', () => {
    const origin = makeTask({
      id: 'task-origin',
      prompt: 'Add login feature\nWith OAuth and email/password.',
      status: 'done',
    })
    const fix = makeTask({
      id: 'fix-4fd4f3f3',
      prompt: '# Recovery run — first-principles (no matching recipe)\nSome details.',
      status: 'failed',
      originId: 'task-origin',
    })

    const snapshot = groupTasks([origin, fix])
    const fixCard = snapshot.columns.done.find(c => c.id === 'fix-4fd4f3f3')

    expect(fixCard).toBeDefined()
    expect(fixCard?.title).toBe('Add login feature')
    // Badge still shows the fix task's own id
    expect(fixCard?.id).toBe('fix-4fd4f3f3')
  })

  it('keeps the origin task title unchanged (originId null)', () => {
    const origin = makeTask({
      id: 'task-origin',
      prompt: 'Add login feature',
      status: 'queued',
    })

    const snapshot = groupTasks([origin])
    const card = snapshot.columns.backlog.find(c => c.id === 'task-origin')

    expect(card).toBeDefined()
    expect(card?.title).toBe('Add login feature')
    expect(card?.priority).toBe(2)
  })

  it('falls back to own prompt when originId is not present in the task list', () => {
    const fix = makeTask({
      id: 'fix-orphan',
      prompt: '# Recovery run — first-principles (no matching recipe)',
      status: 'failed',
      originId: 'task-missing',
    })

    const snapshot = groupTasks([fix])
    const card = snapshot.columns.done.find(c => c.id === 'fix-orphan')

    expect(card).toBeDefined()
    // The leading '#' is stripped: group.ts now shares the same title helper as
    // the board and topology instead of carrying its own first-line-only copy.
    expect(card?.title).toBe('Recovery run — first-principles (no matching recipe)')
  })
})
