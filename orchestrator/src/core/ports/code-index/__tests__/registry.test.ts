import { describe, expect, it } from 'vitest'
import {
  getCodeIndex,
  listCodeIndexes,
  registerCodeIndex,
  requireCodeIndex,
  resolveCodeIndex,
} from '../registry'
import { noneCodeIndex } from '../none'
import { codegraphCodeIndex } from '../codegraph'
import type { CodeIndex } from '../types'

describe('built-in registration', () => {
  it('registers both built-in kinds at import time', () => {
    const kinds = listCodeIndexes()
      .map((impl) => impl.kind)
      .sort()
    expect(kinds).toEqual(['codegraph', 'none'])
  })

  it('getCodeIndex resolves each built-in by kind', () => {
    expect(getCodeIndex('none')).toBe(noneCodeIndex)
    expect(getCodeIndex('codegraph')).toBe(codegraphCodeIndex)
  })

  it('getCodeIndex returns undefined for an unregistered kind', () => {
    expect(getCodeIndex('nope')).toBeUndefined()
  })

  it('requireCodeIndex throws naming the known kinds for an unregistered kind', () => {
    expect(() => requireCodeIndex('nope')).toThrow(/Unknown CodeIndex implementation 'nope'/)
    expect(() => requireCodeIndex('nope')).toThrow(/codegraph/)
    expect(() => requireCodeIndex('nope')).toThrow(/none/)
  })
})

describe('registerCodeIndex()', () => {
  it('registers a new implementation and the returned disposer withdraws it', () => {
    const fake: CodeIndex = {
      kind: 'test-fake',
      async symbols() {
        return []
      },
      async search() {
        return []
      },
      async impact(query) {
        return { symbol: query.symbol, affected: [] }
      },
    }
    const dispose = registerCodeIndex(fake)
    expect(getCodeIndex('test-fake')).toBe(fake)
    dispose()
    expect(getCodeIndex('test-fake')).toBeUndefined()
  })
})

describe('resolveCodeIndex()', () => {
  it('defaults to the none implementation when the env var is unset', () => {
    expect(resolveCodeIndex({})).toBe(noneCodeIndex)
  })

  it('defaults to none when the env var is empty', () => {
    expect(resolveCodeIndex({ MARS_CODE_INDEX_KIND: '' })).toBe(noneCodeIndex)
  })

  it('selects codegraph when the env var requests it', () => {
    expect(resolveCodeIndex({ MARS_CODE_INDEX_KIND: 'codegraph' })).toBe(codegraphCodeIndex)
  })

  it('throws when the env var names a kind the shared Port registry does not know', () => {
    expect(() => resolveCodeIndex({ MARS_CODE_INDEX_KIND: 'bogus' })).toThrow(/not a registered implementation/)
  })

  it('the default binding changes no existing behaviour: empty results, no throw', async () => {
    const index = resolveCodeIndex({})
    await expect(index.symbols({ term: 'anything' })).resolves.toEqual([])
    await expect(index.search({ term: 'anything' })).resolves.toEqual([])
    await expect(index.impact({ symbol: 'anything' })).resolves.toEqual({ symbol: 'anything', affected: [] })
  })
})
