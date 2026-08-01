import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationTimeline } from './ConversationTimeline'

describe('ConversationTimeline', () => {
  it('keeps earlier Subject messages visible with their persisted context when the active Subject changes', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'earlier', threadId: 'subject-earlier', subjectId: 'subject-earlier', subjectTitle: 'Earlier subject', subjectClosed: true,
            role: 'assistant', content: 'This was persisted before opening another subject.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'validation', backingEntityId: 'task-42', resolution: null,
          },
          {
            id: 'active', threadId: 'subject-active', subjectId: 'subject-active', subjectTitle: 'Active subject', subjectClosed: false,
            role: 'user', content: 'Handled by the live tail.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
        ]}
        activeThreadId="subject-active"
      />,
    )

    expect(html).toContain('Earlier subject')
    expect(html).toContain('closed')
    expect(html).toContain('assistant · validation')
    expect(html).toContain('task-42')
    expect(html).toContain('This was persisted before opening another subject.')
    expect(html).not.toContain('Handled by the live tail.')
  })
})
