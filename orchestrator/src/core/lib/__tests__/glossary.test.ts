import { describe, expect, it } from 'vitest'
import {
  generateDefaultSurfaceForms,
  parseGlossary,
  renderGlossary,
  upsertTerm,
  removeTermByName,
} from '../glossary'

describe('generateDefaultSurfaceForms', () => {
  it('produces lowercase singular and regular plural for a plain word', () => {
    expect(generateDefaultSurfaceForms('Order')).toEqual(['order', 'orders'])
  })

  it('appends "es" for words ending in s', () => {
    expect(generateDefaultSurfaceForms('Class')).toEqual(['class', 'classes'])
  })

  it('appends "es" for words ending in x', () => {
    expect(generateDefaultSurfaceForms('Box')).toEqual(['box', 'boxes'])
  })

  it('appends "es" for words ending in z', () => {
    expect(generateDefaultSurfaceForms('Buzz')).toEqual(['buzz', 'buzzes'])
  })

  it('appends "es" for words ending in ch', () => {
    expect(generateDefaultSurfaceForms('Watch')).toEqual(['watch', 'watches'])
  })

  it('appends "es" for words ending in sh', () => {
    expect(generateDefaultSurfaceForms('Dish')).toEqual(['dish', 'dishes'])
  })

  it('replaces trailing y with ies', () => {
    expect(generateDefaultSurfaceForms('Category')).toEqual(['category', 'categories'])
  })

  it('deduplicates when singular and plural would be the same', () => {
    // A pathological case: a word that ends in nothing that triggers
    // the 's' rule but singular === plural is not possible with normal English;
    // dedup is exercised for completeness via an already-lowercase term
    const result = generateDefaultSurfaceForms('order')
    expect(result).toEqual(['order', 'orders'])
    // no duplicates
    expect(new Set(result).size).toBe(result.length)
  })

  it('returns all forms in lowercase only', () => {
    const forms = generateDefaultSurfaceForms('WORKFLOW')
    for (const f of forms) {
      expect(f).toBe(f.toLowerCase())
    }
  })
})

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
    // surface forms are the defaults so no line should appear
    expect(rendered).not.toContain('_Surface forms_:')
  })

  it('returns empty doc for empty input', () => {
    const doc = parseGlossary('')
    expect(doc.terms).toHaveLength(0)
  })

  it('parse-without-line-uses-defaults: surfaceForms defaults when no _Surface forms_ line present', () => {
    const text = `# Project Context

## Language

**Category**:
A grouping of items.
`
    const doc = parseGlossary(text)
    expect(doc.terms[0].surfaceForms).toEqual(['category', 'categories'])
  })

  it('parse-with-override: reads explicit _Surface forms_ line (case-insensitive key)', () => {
    const text = `# Project Context

## Language

**Order**:
A request to purchase items.
_Surface forms_: order, orders, ordering
`
    const doc = parseGlossary(text)
    expect(doc.terms[0].surfaceForms).toEqual(['order', 'orders', 'ordering'])
  })

  it('parse-with-override: _surface forms_ is case-insensitive', () => {
    const text = `# Project Context

## Language

**Order**:
A request.
_SURFACE FORMS_: order, reorder
`
    const doc = parseGlossary(text)
    expect(doc.terms[0].surfaceForms).toEqual(['order', 'reorder'])
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

  it('upsertTerm preserves explicit surfaceForms when provided', () => {
    const doc = parseGlossary('# Project Context\n\n## Language\n\n**Order**:\nOriginal.\n')
    const updated = upsertTerm(doc, {
      term: 'Order',
      definition: 'Updated.',
      aliases: [],
      surfaceForms: ['order', 'orders', 'ordered'],
    })
    expect(updated.terms[0].surfaceForms).toEqual(['order', 'orders', 'ordered'])
  })

  it('upsertTerm populates surfaceForms from defaults when omitted', () => {
    const doc = parseGlossary('# Project Context\n\n## Language\n\n')
    const updated = upsertTerm(doc, {
      term: 'Category',
      definition: 'A grouping.',
      aliases: [],
    })
    expect(updated.terms[0].surfaceForms).toEqual(['category', 'categories'])
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
      terms: [{ term: 'Order', definition: 'A request.', aliases: [], surfaceForms: ['order', 'orders'] }],
      trailer: '',
    })
    expect(out).toContain('# Project Context')
    expect(out).toContain('## Language')
    expect(out).toContain('**Order**:')
  })

  it('render-omits-line-when-defaults: no _Surface forms_ line when forms match auto-generated defaults', () => {
    const out = renderGlossary({
      preamble: '# P\n',
      terms: [
        {
          term: 'Order',
          definition: 'A request.',
          aliases: [],
          surfaceForms: ['order', 'orders'],
        },
      ],
      trailer: '',
    })
    expect(out).not.toContain('_Surface forms_:')
  })

  it('render-emits-line-when-overridden: emits _Surface forms_ line when forms differ from defaults', () => {
    const out = renderGlossary({
      preamble: '# P\n',
      terms: [
        {
          term: 'Order',
          definition: 'A request.',
          aliases: [],
          surfaceForms: ['order', 'orders', 'ordering'],
        },
      ],
      trailer: '',
    })
    expect(out).toContain('_Surface forms_: order, orders, ordering')
  })

  it('round-trips a term with overridden surface forms', () => {
    const text = `# Project Context

## Language

**Order**:
A request.
_Avoid_: Purchase
_Surface forms_: order, orders, ordering
`
    const doc = parseGlossary(text)
    expect(doc.terms[0].surfaceForms).toEqual(['order', 'orders', 'ordering'])
    const rendered = renderGlossary(doc)
    expect(rendered).toContain('_Surface forms_: order, orders, ordering')
    expect(rendered).toContain('_Avoid_: Purchase')
    // and re-parse produces same surfaceForms
    const doc2 = parseGlossary(rendered)
    expect(doc2.terms[0].surfaceForms).toEqual(['order', 'orders', 'ordering'])
  })
})
