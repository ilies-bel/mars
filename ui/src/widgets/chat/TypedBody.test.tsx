// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { TypedBody, markRevealed, resetRevealed } from './TypedBody'
import { ConversationTimeline } from './ConversationTimeline'

const NOTICE = 'I reduced implement workers from 12 to 3 because the host was swapping.'

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'notice-1',
  seq: 1,
  threadId: 'main',
  subjectId: 'main',
  subjectTitle: 'Main thread',
  subjectClosed: false,
  role: 'assistant' as const,
  content: NOTICE,
  segments: [{ type: 'text', text: NOTICE }],
  createdAt: '2026-01-01T00:00:00.000Z',
  kind: 'notice' as const,
  backingEntityId: null,
  resolution: null,
  ...over,
})

const matchMedia = (reduced: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: reduced,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

describe('TypedBody', () => {
  beforeEach(() => {
    resetRevealed()
    matchMedia(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the whole sentence on the server, where nothing can animate', () => {
    const html = renderToStaticMarkup(<TypedBody id="notice-1" text={NOTICE} />)
    expect(html).toContain(NOTICE)
  })

  it('reveals a new arrival character by character, then settles on the full text', () => {
    vi.useFakeTimers()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    act(() => { root.render(<TypedBody id="notice-1" text={NOTICE} />) })

    // Mid-reveal: something is showing, but not the whole sentence yet.
    act(() => { vi.advanceTimersByTime(48) })
    const partial = host.textContent ?? ''
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(NOTICE.length)
    expect(NOTICE.startsWith(partial)).toBe(true)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(host.textContent).toBe(NOTICE)

    act(() => { root.unmount() })
  })

  it('renders instantly when the operator asked for reduced motion', () => {
    matchMedia(true)
    vi.useFakeTimers()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    act(() => { root.render(<TypedBody id="notice-1" text={NOTICE} />) })

    expect(host.textContent).toBe(NOTICE)
    act(() => { root.unmount() })
  })

  it('still types under StrictMode, which runs every layout effect twice', () => {
    // The app renders inside StrictMode. An earlier version marked a message
    // revealed when the animation *started*, so the second effect pass saw it
    // as already-seen and the operator got a pasted sentence.
    vi.useFakeTimers()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    act(() => {
      root.render(<StrictMode><TypedBody id="notice-1" text={NOTICE} /></StrictMode>)
    })

    act(() => { vi.advanceTimersByTime(48) })
    const partial = host.textContent ?? ''
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(NOTICE.length)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(host.textContent).toBe(NOTICE)

    act(() => { root.unmount() })
  })

  it('never retypes a message it has already revealed', () => {
    vi.useFakeTimers()
    markRevealed(['notice-1'])
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    act(() => { root.render(<TypedBody id="notice-1" text={NOTICE} />) })

    expect(host.textContent).toBe(NOTICE)
    act(() => { root.unmount() })
  })

  it('shows the full body when text updates after the animation settled on a shorter earlier value', () => {
    // Regression: when a notice first renders with a short body (e.g. only the
    // first stream chunk) the animation completes quickly and marks the id as
    // revealed. If the full body then arrives as a prop update, the effect was
    // previously returning early without calling setShown(text), leaving the
    // truncated value on screen permanently.
    vi.useFakeTimers()
    const FULL = 'I am flagging token spend because it rose 149% over the last ten minutes — the cap is 50% per window.'
    const SHORT = FULL.slice(0, 6) // 'I am f' — simulates a first stream chunk arriving early
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    // Short text arrives first; animation settles on it and marks the id revealed.
    act(() => { root.render(<TypedBody id="notice-x" text={SHORT} />) })
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(host.textContent).toBe(SHORT) // sanity: animation completed on the short text

    // Full body arrives (e.g. REST re-fetch returns complete segments).
    act(() => { root.render(<TypedBody id="notice-x" text={FULL} />) })
    expect(host.textContent).toBe(FULL) // must show full text, not the earlier 6-char truncation

    act(() => { root.unmount() })
  })

  it('shows the new full body when a dedup update replaces one completed sentence with another', () => {
    // Regression: the cap-change notice uses dedupKey='steward-runtime-tune', so
    // the daemon updates chat_messages in-place when the cap changes again within
    // the coalesce window. Before the fix TypedBody returned early on the
    // revealed.has(id) branch without calling setShown(text), so the card stayed
    // frozen at the first sentence even after the dedup update had replaced the
    // stored body. Observed as truncation because the new longer sentence was
    // mistaken for a partial of the old one at the same character offset.
    vi.useFakeTimers()
    const BODY_A = 'I bumped implement workers from 8 to 11 because the backlog was sustained.'
    const BODY_B = 'I shed implement workers from 11 to 8 because host pressure was detected.'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    // First delivery: animation completes and marks the id as revealed.
    act(() => { root.render(<TypedBody id="notice-tune" text={BODY_A} />) })
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(host.textContent).toBe(BODY_A) // sanity: first sentence fully shown

    // Dedup update: same id, different full sentence (next cap change within the hour).
    act(() => { root.render(<TypedBody id="notice-tune" text={BODY_B} />) })
    expect(host.textContent).toBe(BODY_B) // must show the updated sentence, not the old one

    act(() => { root.unmount() })
  })
})

describe('ConversationTimeline reveal', () => {
  beforeEach(() => {
    resetRevealed()
    matchMedia(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not replay the backlog: everything present at mount is already read', () => {
    vi.useFakeTimers()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    act(() => { root.render(<ConversationTimeline entries={[entry()]} />) })

    expect(host.textContent).toContain(NOTICE)
    act(() => { root.unmount() })
  })

  it('types a Notice that arrives after the feed is already on screen', () => {
    vi.useFakeTimers()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    act(() => { root.render(<ConversationTimeline entries={[entry()]} />) })
    act(() => {
      root.render(
        <ConversationTimeline
          entries={[entry(), entry({ id: 'notice-2', seq: 2, content: 'I paused dispatch.', segments: [{ type: 'text', text: 'I paused dispatch.' }] })]}
        />,
      )
    })

    // The new one starts empty and fills; the old one is untouched.
    expect(host.textContent).toContain(NOTICE)
    expect(host.textContent).not.toContain('I paused dispatch.')

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(host.textContent).toContain('I paused dispatch.')

    act(() => { root.unmount() })
  })

  it('gives a Notice a card and an author, and leaves ordinary turns plain', () => {
    const html = renderToStaticMarkup(
      <ConversationTimeline
        entries={[
          entry(),
          entry({ id: 'reply-1', seq: 2, role: 'user', kind: 'acknowledgment', content: 'Noted', segments: [{ type: 'text', text: 'Noted' }] }),
        ]}
      />,
    )

    expect(html).toContain('data-testid="notice-card-notice-1"')
    expect(html).not.toContain('data-testid="notice-card-reply-1"')
    expect(html).toContain('>Mars<')
  })

  it('shows the updated sentence when a dedup in-place update changes the notice body', () => {
    // Regression: the steward runtime-tune notice uses a fixed dedupKey so the
    // daemon updates the same chat_messages row whenever the cap changes again
    // within the coalesce window. ConversationTimeline re-renders with the same
    // entry id but a new content string. The full new sentence must appear in the
    // DOM — not the old one and not a partial at the old body's character count.
    vi.useFakeTimers()
    const FIRST = 'I bumped implement workers from 8 to 11 because the backlog was sustained.'
    const SECOND = 'I shed implement workers from 11 to 8 because host pressure was detected.'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    // Initial render: notice-1 is in the backlog so it shows instantly.
    act(() => {
      root.render(
        <ConversationTimeline
          entries={[entry({ content: FIRST, segments: [{ type: 'text', text: FIRST }] })]}
        />,
      )
    })
    expect(host.textContent).toContain(FIRST)

    // Dedup update: same id, new body. The timeline re-renders with the same
    // entry id but updated content and segments.
    act(() => {
      root.render(
        <ConversationTimeline
          entries={[entry({ content: SECOND, segments: [{ type: 'text', text: SECOND }] })]}
        />,
      )
    })
    expect(host.textContent).toContain(SECOND)
    expect(host.textContent).not.toContain(FIRST)

    act(() => { root.unmount() })
  })
})
