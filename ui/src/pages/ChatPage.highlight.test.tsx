/**
 * Glossary terms are reflected back to the operator in both sides of a chat
 * transcript, without changing the composer input.
 */

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageView } from './ChatPage'
import type { GlossaryTerm } from '@/shared/schemas'
import type { MarsUIMessage } from '@/shared/marsChatTransport'

const glossary: GlossaryTerm[] = [{
  term: 'Action queue',
  definition: 'The queue of items that need an operator response.',
  avoid: [],
  surfaceForms: ['action queue', 'action queues'],
}]

const message = (role: 'user' | 'assistant', text: string): MarsUIMessage => ({
  id: `${role}-message`,
  role,
  parts: [{ type: 'text', text, state: 'done' }],
})

describe('ChatPage glossary highlights', () => {
  it('highlights glossary phrases in user and assistant transcript messages', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(MessageView, {
          message: message('user', 'Please open the action queue.'),
          onRetry: () => {},
          terms: glossary,
        }),
        createElement(MessageView, {
          message: message('assistant', 'The action queue is ready.'),
          onRetry: () => {},
          terms: glossary,
        }),
      ),
    )

    expect(html.match(/glossary-term-highlight/g)).toHaveLength(2)
    expect(html).toContain('Please open the <span')
    expect(html).toContain('The <span')
  })
})
