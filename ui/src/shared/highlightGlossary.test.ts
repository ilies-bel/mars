import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GlossaryHighlighter } from '@/components/glossary/GlossaryHighlighter'
import type { GlossaryTerm } from './schemas'
import { highlightGlossary } from './highlightGlossary'

const actionQueue: GlossaryTerm = {
  term: 'action queue',
  definition: 'The queue of items that need an operator response.',
  avoid: [],
  surfaceForms: ['action queue'],
}

describe('highlightGlossary', () => {
  it('marks a matching single-word surface form with its glossary term', () => {
    const term: GlossaryTerm = {
      ...actionQueue,
      term: 'task',
      surfaceForms: ['task'],
    }

    expect(highlightGlossary('A task is ready.', [term])).toEqual([
      { kind: 'text', value: 'A ' },
      { kind: 'term', value: 'task', term },
      { kind: 'text', value: ' is ready.' },
    ])
  })

  it('keeps a multi-word surface form together as one term segment', () => {
    expect(highlightGlossary('Open the action queue.', [actionQueue])).toEqual([
      { kind: 'text', value: 'Open the ' },
      { kind: 'term', value: 'action queue', term: actionQueue },
      { kind: 'text', value: '.' },
    ])
  })

  it('matches surface forms regardless of case while preserving transcript text', () => {
    expect(highlightGlossary('ACTION QUEUE is waiting.', [actionQueue])).toEqual([
      { kind: 'term', value: 'ACTION QUEUE', term: actionQueue },
      { kind: 'text', value: ' is waiting.' },
    ])
  })

  it('matches plural wording when it is stored as a surface form', () => {
    const task: GlossaryTerm = {
      ...actionQueue,
      term: 'task',
      surfaceForms: ['task', 'tasks'],
    }

    expect(highlightGlossary('Two tasks remain.', [task])).toEqual([
      { kind: 'text', value: 'Two ' },
      { kind: 'term', value: 'tasks', term: task },
      { kind: 'text', value: ' remain.' },
    ])
  })

  it('prefers the longest overlapping surface form', () => {
    const action: GlossaryTerm = {
      term: 'action',
      definition: 'A discrete operator response.',
      avoid: [],
      surfaceForms: ['action'],
    }

    expect(highlightGlossary('The action queue is open.', [action, actionQueue])).toEqual([
      { kind: 'text', value: 'The ' },
      { kind: 'term', value: 'action queue', term: actionQueue },
      { kind: 'text', value: ' is open.' },
    ])
  })

  it('returns one unchanged text segment when nothing matches', () => {
    expect(highlightGlossary('No operator response is needed.', [actionQueue])).toEqual([
      { kind: 'text', value: 'No operator response is needed.' },
    ])
  })

  it('does not match a surface form inside a larger word', () => {
    const task: GlossaryTerm = {
      ...actionQueue,
      term: 'task',
      surfaceForms: ['task'],
    }

    expect(highlightGlossary('The subtask is still running.', [task])).toEqual([
      { kind: 'text', value: 'The subtask is still running.' },
    ])
  })

  it('renders matched terms as tooltip triggers and leaves no-match text unwrapped', () => {
    const matched = renderToStaticMarkup(
      createElement(GlossaryHighlighter, {
        text: 'Open the action queue.',
        terms: [actionQueue],
      }),
    )
    const unmatched = renderToStaticMarkup(
      createElement(GlossaryHighlighter, {
        text: 'Nothing to highlight.',
        terms: [actionQueue],
      }),
    )
    const empty = renderToStaticMarkup(
      createElement(GlossaryHighlighter, {
        text: 'Nothing to highlight.',
        terms: [],
      }),
    )

    expect(matched).toContain('class="glossary-term-highlight')
    expect(matched).toContain('data-term="action queue"')
    expect(matched).toContain('Open the <span')
    expect(unmatched).toBe('Nothing to highlight.')
    expect(empty).toBe('Nothing to highlight.')
  })
})
