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
  subthreadId: 'main',
  subthreadTitle: 'Main thread',
  subthreadClosed: false,
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
})
