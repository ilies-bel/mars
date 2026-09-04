import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { chatConversationEntrySchema } from '@/shared/schemas'
import { ConversationTimeline } from './ConversationTimeline'

describe('ConversationTimeline', () => {
  it('collapses a closed subject into one breadcrumb row instead of its messages', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'msg1', seq: 1, threadId: 'closed-sub', subjectId: 'closed-sub', subjectTitle: 'Finished task', subjectClosed: true,
            role: 'assistant', content: 'First message.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'msg2', seq: 2, threadId: 'closed-sub', subjectId: 'closed-sub', subjectTitle: 'Finished task', subjectClosed: true,
            role: 'assistant', content: 'Second message.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
        ]}
      />,
    )

    // One breadcrumb instead of two message cards
    expect(html).toContain('data-testid="closed-subthread-breadcrumb"')
    expect(html.match(/data-testid="closed-subthread-breadcrumb"/g)).toHaveLength(1)
    expect(html).toContain('Finished task')
    expect(html).toContain('2 messages')
    // Individual message content is NOT rendered
    expect(html).not.toContain('First message.')
    expect(html).not.toContain('Second message.')
  })

  it('keeps the durable scroll mounted and marks the exact memory cut', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'before-cut', seq: 41, threadId: 'subthread-earlier', subjectId: 'subthread-earlier', subjectTitle: 'Earlier subthread', subjectClosed: true,
            role: 'assistant', content: 'Mars no longer reads this.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'at-cut', seq: 42, threadId: 'subthread-earlier', subjectId: 'subthread-earlier', subjectTitle: 'Earlier subthread', subjectClosed: true,
            role: 'assistant', content: 'This is the final unreadable message.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'after-cut', seq: 43, threadId: 'subthread-current', subjectId: 'subthread-current', subjectTitle: 'Current subthread', subjectClosed: false,
            role: 'user', content: 'Mars reads from here onward.', segments: [],
            createdAt: '2026-01-01T00:02:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
        ]}
        memoryStartsAfterSeq={42}
      />,
    )

    // Closed subject collapses to one breadcrumb — no individual message content
    expect(html).toContain('data-testid="closed-subthread-breadcrumb"')
    expect(html).toContain('Earlier subthread')
    expect(html).not.toContain('Mars no longer reads this.')
    expect(html).not.toContain('This is the final unreadable message.')
    // Memory boundary placed after the closed subject breadcrumb
    expect(html).toContain('Mars can read from here')
    expect(html).toContain('Mars reads from here onward.')
    expect(html.indexOf('closed-subthread-breadcrumb')).toBeLessThan(html.indexOf('Mars can read from here'))
    expect(html.indexOf('Mars can read from here')).toBeLessThan(html.indexOf('Mars reads from here onward.'))
  })

  it('does not render a memory marker while the whole conversation remains readable', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[{
          id: 'only-message', seq: 1, threadId: 'subthread', subjectId: 'subthread', subjectTitle: 'Subthread', subjectClosed: false,
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
        id: 'before-cut', seq: 9, threadId: 'closed-subthread', subjectId: 'closed-subthread', subjectTitle: 'Closed subthread', subjectClosed: true,
        role: 'assistant' as const, content: 'Older message.', segments: [],
        createdAt: '2026-01-01T00:00:00.000Z', kind: 'acknowledgment' as const, backingEntityId: null, resolution: null,
      },
      {
        id: 'after-cut', seq: 10, threadId: 'active-subthread', subjectId: 'active-subthread', subjectTitle: 'Active subthread', subjectClosed: false,
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
      // Closed subject breadcrumb appears before the memory cut marker
      expect(html.indexOf('closed-subthread-breadcrumb')).toBeLessThan(html.indexOf('Mars can read from here'))
      expect(html).toContain('data-testid="memory-boundary-line"')
    }
  })

  it('keeps earlier Subject messages visible with their persisted context when the active Subject changes', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'earlier', seq: 1, threadId: 'subthread-earlier', subjectId: 'subthread-earlier', subjectTitle: 'Earlier subthread', subjectClosed: true,
            role: 'assistant', content: 'This was persisted before opening another subthread.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'validation', backingEntityId: 'task-42', resolution: null,
          },
          {
            id: 'active', seq: 2, threadId: 'subthread-active', subjectId: 'subthread-active', subjectTitle: 'Active subthread', subjectClosed: false,
            role: 'user', content: 'Handled by the live tail.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
        ]}
        activeThreadId="subthread-active"
      />,
    )

    // The closed subject is represented as a breadcrumb with its title
    expect(html).toContain('Earlier subthread')
    expect(html).toContain('data-testid="closed-subthread-breadcrumb"')
    // Individual message details are not replayed in the main transcript
    expect(html).not.toContain('This was persisted before opening another subthread.')
    // Active subject is rendered by the live tail, not here
    expect(html).not.toContain('Handled by the live tail.')
  })

  it('places Subject seams around open Subject messages while leaving closed Subjects as breadcrumbs', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          {
            id: 'situation', seq: 1, threadId: 'closed-subthread', subjectId: 'closed-subthread', subjectTitle: 'Completed subthread', subjectClosed: true,
            role: 'assistant', content: 'Situation: this Subject starts here.', segments: [],
            createdAt: '2026-01-01T00:00:00.000Z', kind: 'situation', backingEntityId: null, resolution: null,
          },
          {
            id: 'final', seq: 2, threadId: 'closed-subthread', subjectId: 'closed-subthread', subjectTitle: 'Completed subthread', subjectClosed: true,
            role: 'assistant', content: 'The last completed message.', segments: [],
            createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
          },
          {
            id: 'open-situation', seq: 3, threadId: 'open-subthread', subjectId: 'open-subthread', subjectTitle: 'Open subthread', subjectClosed: false,
            role: 'assistant', content: 'Situation: this one remains open.', segments: [],
            createdAt: '2026-01-01T00:02:00.000Z', kind: 'situation', backingEntityId: null, resolution: null,
          },
        ]}
        boundaries={[
          { subjectId: 'closed-subthread', startedAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T00:02:00.000Z', producedTokens: 350, carriedTokens: 180 },
          { subjectId: 'open-subthread', startedAt: '2026-01-01T00:02:00.000Z', closedAt: null, producedTokens: 100, carriedTokens: 90 },
        ]}
        memoryStartsAfterSeq={2}
      />,
    )

    // Closed subject collapses to a breadcrumb with its token summary
    expect(html).toContain('data-testid="closed-subthread-breadcrumb"')
    expect(html).toContain('350 produced')
    expect(html).toContain('180 carried')
    expect(html).not.toContain('Situation: this Subject starts here.')
    expect(html).not.toContain('The last completed message.')

    // Memory boundary placed after the closed-subject breadcrumb
    expect(html).toContain('data-testid="memory-boundary-line"')

    // Open subject still gets a start boundary seam (no end since not closed)
    expect(html.match(/data-testid="subthread-boundary-start"/g)).toHaveLength(1)
    expect(html).not.toContain('data-testid="subthread-boundary-end"')
    expect(html).toContain('Situation: this one remains open.')
  })

  it('renders an entry parsed from the daemon wire shape (subject* field names through chatConversationEntrySchema)', () => {
    // This test asserts against the wire shape — the exact field names the daemon
    // emits. It is the regression guard for the Subthread→Subject rename: had a
    // test like this existed before, the schema mismatch would have been caught
    // the moment it shipped, not discovered via a blank conversation pane.
    const wirePayload = {
      id: 'notice-1',
      seq: 1,
      threadId: 'subject-abc',
      subjectId: 'subject-abc',
      subjectTitle: 'Worker pool steward',
      subjectClosed: false,
      role: 'assistant',
      content: 'I increased implement workers from 3 to 4 because queue depth exceeded the threshold.',
      segments: [],
      createdAt: '2026-08-25T12:01:23.000Z',
      kind: 'notice',
      backingEntityId: null,
      resolution: null,
    }

    // Parse through the schema exactly as the UI does at runtime.
    const result = chatConversationEntrySchema.safeParse(wirePayload)
    expect(result.success).toBe(true)
    if (!result.success) return // type-narrow; the expect above already fails the test

    const html = renderToStaticMarkup(
      <ConversationTimeline entries={[result.data]} />,
    )

    // The notice content must be visible.
    expect(html).toContain('I increased implement workers from 3 to 4')
    expect(html).toContain('data-testid="conversation-timeline"')
    // A notice renders with a notice card.
    expect(html).toContain('data-testid="notice-card-notice-1"')
  })

  it('renders the full body of a notice with a long body (regression: body must not be truncated)', () => {
    // A notice body is stored in full in chat_messages.content and chat_messages.segments.
    // The rendered card must expose every character; truncation to the first stream chunk
    // (as few as 6 chars) is the bug this test guards against.
    const body = 'I am flagging token spend because it rose 149% over the last ten minutes — the cap is 50% per window.'
    expect(body.length).toBeGreaterThan(90) // self-check so future edits don't silently shorten

    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[{
          id: 'notice-spend', seq: 1, threadId: 'main', subjectId: 'main',
          subjectTitle: 'Main', subjectClosed: false, role: 'assistant',
          content: body, segments: [{ type: 'text', text: body }],
          createdAt: '2026-01-01T00:00:00.000Z', kind: 'notice',
          backingEntityId: null, resolution: null,
        }]}
      />,
    )

    expect(html).toContain(body)
    expect(html).toContain('data-testid="notice-card-notice-spend"')
  })

  it('renders an error state instead of a blank pane when loadError is set and entries are empty', () => {
    const error = new Error('GET /api/chat/conversation → response failed schema validation')
    const html = renderToStaticMarkup(
      <ConversationTimeline entries={[]} loadError={error} />,
    )

    expect(html).toContain('data-testid="conversation-timeline"')
    expect(html).toContain('data-testid="conversation-load-error"')
    expect(html).toContain('response failed schema validation')
    // Must NOT look like an empty conversation — no spacer-only output
    expect(html).not.toContain('data-testid="composer-scroll-spacer"')
  })
})
