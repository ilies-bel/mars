import { describe, expect, it } from 'vitest'
import { toThreadApiView, type ChatThread } from '../chat-store'

describe('toThreadApiView', () => {
  it('returns a session-free chat thread API view', () => {
    const thread: ChatThread = {
      id: 'thread-1',
      title: 'Test chat',
      status: 'idle',
      posture: 'triage',
      created_at: 1_754_051_200_000,
      updated_at: 1_754_051_200_000,
      origin: null,
      alert_item_id: null,
      alert_resolved: false,
      closed_at: null,
      archived_at: null,
      parent_thread_id: null,
      fork_idempotency_key: null,
    }

    const view = toThreadApiView(thread)

    expect(view).not.toHaveProperty('sessionId')
    expect(view).not.toHaveProperty('contextSeeded')
  })
})
