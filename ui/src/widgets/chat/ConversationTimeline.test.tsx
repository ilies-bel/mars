import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationTimeline } from './ConversationTimeline'

describe('ConversationTimeline', () => {
  it('keeps the durable scroll mounted and marks the exact memory cut', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'before-cut', seq: 41, threadId: 'subject-earlier', subjectId: 'subject-earlier', subjectTitle: 'Earlier subject', subjectClosed: true,
            role: 'assistant', content: 'Mars no longer reads this.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'at-cut', seq: 42, threadId: 'subject-earlier', subjectId: 'subject-earlier', subjectTitle: 'Earlier subject', subjectClosed: true,
            role: 'assistant', content: 'This is the final unreadable message.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'after-cut', seq: 43, threadId: 'subject-current', subjectId: 'subject-current', subjectTitle: 'Current subject', subjectClosed: false,
            role: 'user', content: 'Mars reads from here onward.', segments: [],
            createdAt: '2026-01-01T00:02:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
        ]}
        memoryStartsAfterSeq={42}
      />,
    )

    expect(html).toContain('Mars no longer reads this.')
    expect(html).toContain('This is the final unreadable message.')
    expect(html).toContain('Mars can read from here')
    expect(html).toContain('Mars reads from here onward.')
    expect(html.indexOf('This is the final unreadable message.')).toBeLessThan(html.indexOf('Mars can read from here'))
    expect(html.indexOf('Mars can read from here')).toBeLessThan(html.indexOf('Mars reads from here onward.'))
  })

  it('does not render a memory marker while the whole conversation remains readable', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[{
          id: 'only-message', seq: 1, threadId: 'subject', subjectId: 'subject', subjectTitle: 'Subject', subjectClosed: false,
          role: 'assistant', content: 'Everything is readable.', segments: [],
          createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
        }]}
        memoryStartsAfterSeq={0}
      />,
    )

    expect(html).not.toContain('Mars can read from here')
  })

  it('keeps the server-selected marker in the same place when the active Subject layout changes', () => {
    const entries = [
      {
        id: 'before-cut', seq: 9, threadId: 'closed-subject', subjectId: 'closed-subject', subjectTitle: 'Closed subject', subjectClosed: true,
        role: 'assistant' as const, content: 'Older message.', segments: [],
        createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment' as const, backingEntityId: null, resolution: null,
      },
      {
        id: 'after-cut', seq: 10, threadId: 'active-subject', subjectId: 'active-subject', subjectTitle: 'Active subject', subjectClosed: false,
        role: 'user' as const, content: 'Current message.', segments: [],
        createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment' as const, backingEntityId: null, resolution: null,
      },
    ]

    const withActiveTail = renderToStaticMarkup(
      <ConversationTimeline entries={entries} memoryStartsAfterSeq={9} activeThreadId="active-subject" />,
    )
    const withoutActiveTail = renderToStaticMarkup(
      <ConversationTimeline entries={entries} memoryStartsAfterSeq={9} />,
    )

    for (const html of [withActiveTail, withoutActiveTail]) {
      expect(html.indexOf('Older message.')).toBeLessThan(html.indexOf('Mars can read from here'))
      expect(html).toContain('data-testid="memory-boundary-line"')
    }
  })

  it('keeps earlier Subject messages visible with their persisted context when the active Subject changes', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'earlier', seq: 1, threadId: 'subject-earlier', subjectId: 'subject-earlier', subjectTitle: 'Earlier subject', subjectClosed: true,
            role: 'assistant', content: 'This was persisted before opening another subject.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'validation', backingEntityId: 'task-42', resolution: null,
          },
          {
            id: 'active', seq: 2, threadId: 'subject-active', subjectId: 'subject-active', subjectTitle: 'Active subject', subjectClosed: false,
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
