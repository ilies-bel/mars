import { afterEach, describe, expect, it } from 'bun:test'
import {
  getOpenTaskId,
  setOpenTaskId,
  subscribeOpenTaskId,
} from './openTaskId'

afterEach(() => {
  setOpenTaskId(null)
})

describe('openTaskId store', () => {
  it('starts cleared', () => {
    expect(getOpenTaskId()).toBeNull()
  })

  it('exposes the most recently set id', () => {
    setOpenTaskId('task-abc')
    expect(getOpenTaskId()).toBe('task-abc')

    setOpenTaskId('task-xyz')
    expect(getOpenTaskId()).toBe('task-xyz')
  })

  it('notifies subscribers when the id changes', () => {
    let calls = 0
    const unsub = subscribeOpenTaskId(() => {
      calls += 1
    })

    setOpenTaskId('task-1')
    setOpenTaskId('task-2')
    expect(calls).toBe(2)

    unsub()
    setOpenTaskId('task-3')
    expect(calls).toBe(2)
  })

  it('does not notify when the value is unchanged', () => {
    setOpenTaskId('task-7')
    let calls = 0
    const unsub = subscribeOpenTaskId(() => {
      calls += 1
    })
    setOpenTaskId('task-7')
    expect(calls).toBe(0)
    unsub()
  })

  it('clears back to null', () => {
    setOpenTaskId('task-1')
    setOpenTaskId(null)
    expect(getOpenTaskId()).toBeNull()
  })
})
