import { describe, expect, it } from 'vitest'
import {
  parseGlossary,
  renderGlossary,
  upsertTerm,
  removeTermByName,
} from '../glossary'

describe('glossary parser', () => {
  it('parses a populated CONTEXT.md and round-trips through render', () => {
    const text = `# Project Context

Some preamble text.

## Language

**Order**:
A request to purchase one or more items.
_Avoid_: Purchase, Transaction

**Customer**:
A person who places orders.

## Notes

Trailing prose stays put.
`
    const doc = parseGlossary(text)
    expect(doc.terms).toHaveLength(2)
    expect(doc.terms[0].term).toBe('Order')
    expect(doc.terms[0].aliases).toEqual(['Purchase', 'Transaction'])
    expect(doc.terms[1].term).toBe('Customer')
    expect(doc.terms[1].aliases).toEqual([])

    const rendered = renderGlossary(doc)
    expect(rendered).toContain('## Language')
    expect(rendered).toContain('**Order**:')
    expect(rendered).toContain('_Avoid_: Purchase, Transaction')
    expect(rendered).toContain('## Notes')
  })

  it('returns empty doc for empty input', () => {
    const doc = parseGlossary('')
    expect(doc.terms).toHaveLength(0)
  })

  it('upserts a new term and replaces an existing one (case-insensitive)', () => {
    const doc = parseGlossary('# Project Context\n\n## Language\n\n**Order**:\nOriginal definition.\n')
    const added = upsertTerm(doc, {
      term: 'Customer',
      definition: 'New term.',
      aliases: [],
    })
    expect(added.terms).toHaveLength(2)

    const replaced = upsertTerm(added, {
      term: 'order',
      definition: 'Replaced definition.',
      aliases: ['Buy'],
    })
    expect(replaced.terms).toHaveLength(2)
    const order = replaced.terms.find((t) => t.term.toLowerCase() === 'order')
    expect(order?.definition).toBe('Replaced definition.')
    expect(order?.aliases).toEqual(['Buy'])
  })

  it('removes a term by name and reports whether anything was removed', () => {
    const doc = parseGlossary(
      '# Project Context\n\n## Language\n\n**Order**:\nOriginal.\n\n**Customer**:\nA buyer.\n',
    )
    const r1 = removeTermByName(doc, 'order')
    expect(r1.removed).toBe(true)
    expect(r1.doc.terms).toHaveLength(1)
    const r2 = removeTermByName(r1.doc, 'nope')
    expect(r2.removed).toBe(false)
  })

  it('renders a fresh doc with the default header when preamble is empty', () => {
    const out = renderGlossary({
      preamble: '',
      terms: [{ term: 'Order', definition: 'A request.', aliases: [] }],
      trailer: '',
    })
    expect(out).toContain('# Project Context')
    expect(out).toContain('## Language')
    expect(out).toContain('**Order**:')
  })
})
