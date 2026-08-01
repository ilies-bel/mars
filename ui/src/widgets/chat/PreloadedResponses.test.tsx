import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PreloadedResponses } from './PreloadedResponses'
import { ConversationTimeline } from './ConversationTimeline'

describe('PreloadedResponses', () => {
  it('renders template responses in their stored order', () => {
    const html = renderToStaticMarkup(
      <PreloadedResponses
        messageId="notice-1"
        resolved={false}
        responses={[
          { id: 'first', label: 'First choice', target: { type: 'verb', op: 'restart', entityId: 'task-1' } },
          { id: 'second', label: 'Open a Subthread', target: { type: 'subthread', title: 'Investigate task' } },
        ]}
      />,
    )

    expect(html.indexOf('First choice')).toBeLessThan(html.indexOf('Open a Subthread'))
  })

  it('disables resolved backing responses with a Resolved label', () => {
    const html = renderToStaticMarkup(
      <PreloadedResponses
        messageId="notice-1"
        resolved
        responses={[{ id: 'restart', label: 'Restart', target: { type: 'verb', op: 'restart', entityId: 'task-1' } }]}
      />,
    )

    expect(html).toContain('disabled=""')
    expect(html).toContain('Resolved')
    expect(html).not.toContain('>Restart<')
  })

  it('renders nothing when a coder-authored message has no responses', () => {
    const html = renderToStaticMarkup(
      <PreloadedResponses messageId="message-1" resolved={false} responses={[]} />,
    )

    expect(html).toBe('')
  })

  it('renders Notice responses from the conversation segment and leaves ordinary messages bare', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline entries={[
        {
          id: 'notice-1', seq: 1, threadId: 'subthread-1', subthreadId: 'subthread-1', subthreadTitle: 'Subthread', subthreadClosed: false,
          role: 'assistant', content: 'Choose.', segments: [{
            type: 'preloaded_responses',
            responses: [{ id: 'open', label: 'Open it', target: { type: 'subthread', title: 'Investigate' } }],
          }],
          createdAt: '2026-01-01T00:00:00.000Z', kind: 'notice', backingEntityId: null, resolution: null,
        },
        {
          id: 'coder-1', seq: 2, threadId: 'subthread-1', subthreadId: 'subthread-1', subthreadTitle: 'Subthread', subthreadClosed: false,
          role: 'assistant', content: 'Plain narration.', segments: [],
          createdAt: '2026-01-01T00:01:00.000Z', kind: 'acknowledgment', backingEntityId: null, resolution: null,
        },
      ]} />,
    )

    expect(html).toContain('data-testid="preloaded-responses"')
    expect(html).toContain('Open it')
    expect((html.match(/data-testid="preloaded-responses"/g) ?? [])).toHaveLength(1)
  })
})
