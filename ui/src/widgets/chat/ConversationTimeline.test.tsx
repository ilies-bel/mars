import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationTimeline } from './ConversationTimeline'

describe('ConversationTimeline', () => {
  it('keeps the durable scroll mounted and marks the exact memory cut', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'before-cut', seq: 41, threadId: 'subthread-earlier', subthreadId: 'subthread-earlier', subthreadTitle: 'Earlier subthread', subthreadClosed: true,
            role: 'assistant', content: 'Mars no longer reads this.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'at-cut', seq: 42, threadId: 'subthread-earlier', subthreadId: 'subthread-earlier', subthreadTitle: 'Earlier subthread', subthreadClosed: true,
            role: 'assistant', content: 'This is the final unreadable message.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'after-cut', seq: 43, threadId: 'subthread-current', subthreadId: 'subthread-current', subthreadTitle: 'Current subthread', subthreadClosed: false,
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
          id: 'only-message', seq: 1, threadId: 'subthread', subthreadId: 'subthread', subthreadTitle: 'Subthread', subthreadClosed: false,
          role: 'assistant', content: 'Everything is readable.', segments: [],
          createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
        }]}
        memoryStartsAfterSeq={0}
      />,
    )

    expect(html).not.toContain('Mars can read from here')
  })

  it('keeps the server-selected marker in the same place when the active Subthread layout changes', () => {
    const entries = [
      {
        id: 'before-cut', seq: 9, threadId: 'closed-subthread', subthreadId: 'closed-subthread', subthreadTitle: 'Closed subthread', subthreadClosed: true,
        role: 'assistant' as const, content: 'Older message.', segments: [],
        createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment' as const, backingEntityId: null, resolution: null,
      },
      {
        id: 'after-cut', seq: 10, threadId: 'active-subthread', subthreadId: 'active-subthread', subthreadTitle: 'Active subthread', subthreadClosed: false,
        role: 'user' as const, content: 'Current message.', segments: [],
        createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment' as const, backingEntityId: null, resolution: null,
      },
    ]

    const withActiveTail = renderToStaticMarkup(
      <ConversationTimeline entries={entries} memoryStartsAfterSeq={9} activeThreadId="active-subthread" />,
    )
    const withoutActiveTail = renderToStaticMarkup(
      <ConversationTimeline entries={entries} memoryStartsAfterSeq={9} />,
    )

    for (const html of [withActiveTail, withoutActiveTail]) {
      expect(html.indexOf('Older message.')).toBeLessThan(html.indexOf('Mars can read from here'))
      expect(html).toContain('data-testid="memory-boundary-line"')
    }
  })

  it('keeps earlier Subthread messages visible with their persisted context when the active Subthread changes', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'earlier', seq: 1, threadId: 'subthread-earlier', subthreadId: 'subthread-earlier', subthreadTitle: 'Earlier subthread', subthreadClosed: true,
            role: 'assistant', content: 'This was persisted before opening another subthread.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'validation', backingEntityId: 'task-42', resolution: null,
          },
          {
            id: 'active', seq: 2, threadId: 'subthread-active', subthreadId: 'subthread-active', subthreadTitle: 'Active subthread', subthreadClosed: false,
            role: 'user', content: 'Handled by the live tail.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
        ]}
        activeThreadId="subthread-active"
      />,
    )

    expect(html).toContain('Earlier subthread')
    expect(html).toContain('closed')
    expect(html).toContain('assistant · validation')
    expect(html).toContain('task-42')
    expect(html).toContain('This was persisted before opening another subthread.')
    expect(html).not.toContain('Handled by the live tail.')
  })

  it('places Subthread seams around closed messages while leaving an open Subthread without an end aggregate', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'situation', seq: 1, threadId: 'closed-subthread', subthreadId: 'closed-subthread', subthreadTitle: 'Completed subthread', subthreadClosed: true,
            role: 'assistant', content: 'Situation: this Subthread starts here.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'situation', backingEntityId: null, resolution: null,
          },
          {
            id: 'final', seq: 2, threadId: 'closed-subthread', subthreadId: 'closed-subthread', subthreadTitle: 'Completed subthread', subthreadClosed: true,
            role: 'assistant', content: 'The last completed message.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'open-situation', seq: 3, threadId: 'open-subthread', subthreadId: 'open-subthread', subthreadTitle: 'Open subthread', subthreadClosed: false,
            role: 'assistant', content: 'Situation: this one remains open.', segments: [],
            createdAt: '2026-01-01T00:02:00.000Z', kind: 'situation', backingEntityId: null, resolution: null,
          },
        ]}
        boundaries={[
          { subthreadId: 'closed-subthread', startedAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T00:02:00.000Z', producedTokens: 350, carriedTokens: 180 },
          { subthreadId: 'open-subthread', startedAt: '2026-01-01T00:02:00.000Z', closedAt: null, producedTokens: 100, carriedTokens: 90 },
        ]}
        memoryStartsAfterSeq={2}
      />,
    )

    expect(html.match(/data-testid="subthread-boundary-start"/g)).toHaveLength(2)
    expect(html.match(/data-testid="subthread-boundary-end"/g)).toHaveLength(1)
    expect(html).toContain('350 produced')
    expect(html).toContain('180 carried')
    expect(html.indexOf('Subthread started')).toBeLessThan(html.indexOf('Situation: this Subthread starts here.'))
    expect(html.indexOf('The last completed message.')).toBeLessThan(html.indexOf('Subthread complete'))
    expect(html).toContain('data-testid="memory-boundary-line"')
  })
})
