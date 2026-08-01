import { describe, expect, it } from 'vitest'
import { buildMainThreadPrefix } from '../chat-context'
import type { ChatMessage } from '../../lib/chat-store'

const message = (
  id: string,
  content: string,
  context_scope: 'main' | 'subthread',
  kind: ChatMessage['kind'] = 'acknowledgment',
): ChatMessage => ({
  id,
  thread_id: 'subthread-a',
  role: 'assistant',
  content,
  segments: null,
  created_at: 0,
  context_scope,
  kind,
  backing_entity_id: null,
})

describe('buildMainThreadPrefix', () => {
  it('keeps only reusable Main entries and compact Subthread boundaries', () => {
    const prefix = buildMainThreadPrefix([
      message('notice', 'Mars lowered workers to two.', 'main'),
      message('closed-investigation', 'x'.repeat(200_000), 'subthread'),
      message('subthread-boundary', 'Situation: 1 running task.', 'subthread', 'situation'),
      message('active-subthread', 'Investigate the timeout.', 'subthread'),
    ])

    expect(prefix.map((entry) => entry.id)).toEqual(['notice', 'subthread-boundary'])
  })
})
