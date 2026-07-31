/**
 * ChatHero — recipe-autorun hero feed line tests.
 *
 * Verifies that when recipe auto-run events are passed to WhatHappenedTodayView
 * (the hero "delta" view), each event renders as a 🤖-prefixed one-liner
 * visible to the user.
 *
 * Heavy AI-Elements components (Conversation, Message, Response) are mocked with
 * lightweight pass-through wrappers so `renderToStaticMarkup` works in the node
 * environment without a real DOM. The recipe-autorun feed lines are rendered as
 * plain HTML (not streaming) so they appear in the initial static markup.
 */

import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// ---------------------------------------------------------------------------
// Module mocks — registered before the dynamic component import.
// vi.mock (aliased as mock.module via bun-test-compat) is hoisted by vitest
// so the factory runs before the module under test is evaluated.
// ---------------------------------------------------------------------------

mock.module('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: { children?: React.ReactNode }) =>
    <div data-testid="conversation">{children}</div>,
  ConversationContent: ({ children }: { children?: React.ReactNode }) =>
    <div data-testid="conversation-content">{children}</div>,
  ConversationScrollButton: () => null,
}))

mock.module('@/components/ai-elements/message', () => ({
  Message: ({ children }: { children?: React.ReactNode }) =>
    <div data-testid="message">{children}</div>,
  MessageContent: ({ children }: { children?: React.ReactNode }) =>
    <div data-testid="message-content">{children}</div>,
}))

mock.module('@/components/ai-elements/response', () => ({
  Response: ({ children }: { children?: React.ReactNode }) =>
    <span data-testid="response">{children}</span>,
}))

// Import the components under test AFTER mocks are registered so the mocked
// modules are in place when WhatHappenedTodayView resolves its imports.
// ChatHero does not use the mocked AI-elements, but we import it here for
// consistent ordering.
const { WhatHappenedTodayView } = await import(
  '@/widgets/chat/WhatHappenedTodayView'
)
const { ChatHero } = await import('@/widgets/chat/ChatHero')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AutorunEntry = { kind: 'recipe-autorun'; text: string }

const makeEntry = (overrides: Partial<AutorunEntry> = {}): AutorunEntry => ({
  kind: 'recipe-autorun',
  text: 'Coder was killed by restart on task mars-42 — auto-continued per your teach on Jul 20',
  ...overrides,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatHappenedTodayView — recipe-autorun hero feed lines', () => {
  it('renders a 🤖 prefix for a single recipe-autorun entry', () => {
    const html = renderToStaticMarkup(
      <WhatHappenedTodayView onBack={() => {}} autorunEntries={[makeEntry()]} />,
    )
    expect(html).toContain('🤖')
    expect(html).toContain('auto-continued per your teach on Jul 20')
  })

  it('renders the task id and failure kind in the feed line', () => {
    const html = renderToStaticMarkup(
      <WhatHappenedTodayView
        onBack={() => {}}
        autorunEntries={[
          makeEntry({ text: 'Coder was killed by timeout on task mars-99 — auto-continued per your teach on Jul 20' }),
        ]}
      />,
    )
    expect(html).toContain('mars-99')
    expect(html).toContain('timeout')
  })

  it('renders no 🤖 lines when autorunEntries is empty', () => {
    const html = renderToStaticMarkup(
      <WhatHappenedTodayView onBack={() => {}} autorunEntries={[]} />,
    )
    expect(html).not.toContain('🤖')
    expect(html).not.toContain('recipe-autorun-feed')
  })

  it('renders one 🤖 line per entry', () => {
    const entries: AutorunEntry[] = [
      makeEntry({ text: 'entry A' }),
      makeEntry({ text: 'entry B' }),
      makeEntry({ text: 'entry C' }),
    ]
    const html = renderToStaticMarkup(
      <WhatHappenedTodayView onBack={() => {}} autorunEntries={entries} />,
    )
    // Count recipe-autorun-line testids.
    const matches = html.match(/data-testid="recipe-autorun-line"/g) ?? []
    expect(matches.length).toBe(3)
    expect(html).toContain('entry A')
    expect(html).toContain('entry B')
    expect(html).toContain('entry C')
  })
})

// ---------------------------------------------------------------------------
// ChatHero — sectioned inline delta rendering
// ---------------------------------------------------------------------------

import type { HeroDelta } from '@/widgets/chat/ChatHero'

const makeDelta = (overrides: Partial<HeroDelta> = {}): HeroDelta => ({
  merges: [],
  recoveries: [],
  recipes: [],
  throttles: [],
  evaporated: [],
  ...overrides,
})

describe('ChatHero — sectioned delta rendering', () => {
  it('renders all five section headers when delta has one item per section', () => {
    const delta = makeDelta({
      merges: [{ kind: 'merge', taskId: 'mars-1', title: 'Add feature X', at: '2026-07-20T10:00:00Z' }],
      recoveries: [{ kind: 'recovery', taskId: 'fix-1', originTaskId: 'mars-1', title: 'Fix timeout', at: '2026-07-20T11:00:00Z' }],
      recipes: [{ kind: 'recipe-autorun', text: 'Coder was killed by restart on task mars-2 — auto-continued per your teach on Jul 20' }],
      throttles: [{ kind: 'throttle', taskId: 'mars-3', reason: 'Rate limit', at: '2026-07-20T12:00:00Z' }],
      evaporated: [{ kind: 'evaporated', threadId: 'thread-1', title: 'Old alert', at: '2026-07-20T09:00:00Z' }],
    })
    const html = renderToStaticMarkup(<ChatHero delta={delta} onBack={() => {}} />)
    expect(html).toContain('data-testid="delta-section-merges"')
    expect(html).toContain('data-testid="delta-section-recoveries"')
    expect(html).toContain('data-testid="delta-section-recipes"')
    expect(html).toContain('data-testid="delta-section-throttles"')
    expect(html).toContain('data-testid="delta-section-evaporated"')
  })

  it('omits a section when it has no items', () => {
    const delta = makeDelta({
      merges: [{ kind: 'merge', taskId: 'mars-1', title: 'Add feature X', at: '2026-07-20T10:00:00Z' }],
      // recoveries, recipes, throttles, evaporated all empty
    })
    const html = renderToStaticMarkup(<ChatHero delta={delta} onBack={() => {}} />)
    expect(html).toContain('data-testid="delta-section-merges"')
    expect(html).not.toContain('data-testid="delta-section-recoveries"')
    expect(html).not.toContain('data-testid="delta-section-recipes"')
    expect(html).not.toContain('data-testid="delta-section-throttles"')
    expect(html).not.toContain('data-testid="delta-section-evaporated"')
  })

  it('renders merge task id and title in the merges section', () => {
    const delta = makeDelta({
      merges: [{ kind: 'merge', taskId: 'mars-42', title: 'Ship the thing', at: '2026-07-20T10:00:00Z' }],
    })
    const html = renderToStaticMarkup(<ChatHero delta={delta} onBack={() => {}} />)
    expect(html).toContain('mars-42')
    expect(html).toContain('Ship the thing')
  })

  it('renders recipe text in the recipes section', () => {
    const delta = makeDelta({
      recipes: [{ kind: 'recipe-autorun', text: 'auto-continued per your teach on Jul 21' }],
    })
    const html = renderToStaticMarkup(<ChatHero delta={delta} onBack={() => {}} />)
    expect(html).toContain('auto-continued per your teach on Jul 21')
  })

  it('renders a back button', () => {
    const html = renderToStaticMarkup(<ChatHero delta={makeDelta()} onBack={() => {}} />)
    expect(html).toContain('data-testid="chat-hero-back"')
  })
})
