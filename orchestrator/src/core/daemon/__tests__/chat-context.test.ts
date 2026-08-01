import { describe, expect, it } from 'vitest'
import { buildMainSessionPrefix } from '../chat-context'
import type { ChatMessage } from '../../lib/chat-store'

const message = (
  id: string,
  content: string,
  context_scope: 'main' | 'subject',
  kind: ChatMessage['kind'] = 'acknowledgment',
): ChatMessage => ({
  id,
  thread_id: 'subject-a',
  role: 'assistant',
  content,
  segments: null,
  created_at: 0,
  context_scope,
  kind,
  backing_entity_id: null,
})

describe('buildMainSessionPrefix', () => {
  it('keeps only reusable Main entries and compact Subject boundaries', () => {
    const prefix = buildMainSessionPrefix([
      message('notice', 'Mars lowered workers to two.', 'main'),
      message('closed-investigation', 'x'.repeat(200_000), 'subject'),
      message('subject-boundary', 'Situation: 1 running task.', 'subject', 'situation'),
      message('active-subject', 'Investigate the timeout.', 'subject'),
    ])

    expect(prefix.map((entry) => entry.id)).toEqual(['notice', 'subject-boundary'])
  })
})
