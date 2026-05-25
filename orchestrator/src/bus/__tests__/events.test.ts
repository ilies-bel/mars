import { describe, it, expect } from 'vitest'
import { EventMap } from '../events.js'

describe('EventMap — removed question/answer events', () => {
  it('declares no question.* event types (feature removed, PRD eb6f8cc6)', () => {
    const keys = Object.keys(EventMap)
    const questionKeys = keys.filter((k) => k.startsWith('question.'))
    expect(questionKeys).toHaveLength(0)
  })
})
