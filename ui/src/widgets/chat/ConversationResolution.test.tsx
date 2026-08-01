import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { chatConversationEntrySchema } from '@/shared/schemas'
import { ConversationTimeline } from './ConversationTimeline'

describe('ConversationTimeline resolution', () => {
  it('labels a resolved message without changing its persisted body or position', () => {
    const entry = chatConversationEntrySchema.parse({
      id: 'validation-message',
      seq: 1,
      threadId: 'subthread-1',
      subthreadId: 'subthread-1',
      subthreadTitle: 'Approval needed',
      subthreadClosed: false,
      role: 'assistant',
      content: 'Please approve the implementation.',
      segments: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      kind: 'validation',
      backingEntityId: 'task-1',
      resolution: 'resolved',
    })

    const html = renderToStaticMarkup(<ConversationTimeline entries={[entry]} />)

    expect(entry.resolution).toBe('resolved')
    expect(html).toContain('Please approve the implementation.')
    expect(html.indexOf('Resolved')).toBeLessThan(html.indexOf('Please approve the implementation.'))
    expect(html).not.toContain('<button')
  })
})
