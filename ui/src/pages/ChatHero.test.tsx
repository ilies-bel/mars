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

// Import the component under test AFTER mocks are registered so the mocked
// modules are in place when WhatHappenedTodayView resolves its imports.
const { WhatHappenedTodayView } = await import(
  '@/widgets/chat/WhatHappenedTodayView'
)

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
