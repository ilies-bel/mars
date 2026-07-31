import { describe, expect, it } from 'vitest'
import { glossaryResponseSchema } from './schemas'

describe('glossaryResponseSchema', () => {
  it('parses glossary terms with surface forms', () => {
    const response = glossaryResponseSchema.parse({
      terms: [{ term: 'x', definition: 'y', avoid: [], surfaceForms: ['x', 'xs'] }],
    })

    expect(response.terms[0]?.surfaceForms).toEqual(['x', 'xs'])
  })

  it('rejects non-string surface forms', () => {
    expect(() => glossaryResponseSchema.parse({
      terms: [{ term: 'x', definition: 'y', avoid: [], surfaceForms: ['x', 1] }],
    })).toThrow()
  })
})
