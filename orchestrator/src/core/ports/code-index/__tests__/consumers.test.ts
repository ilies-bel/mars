/**
 * Wiring tests for the three CodeIndex consumers (PRD ae17340a, slice 31):
 *   - overlapScoreWithCodeIndex   (../../lib/overlap-scorer.ts)
 *   - buildIndexCardWithCodeIndex (../../lib/index-card/build.ts)
 *   - validateSliceReferencesWithCodeIndex (../../../workflows/slice-reference-validator.ts)
 *
 * Each consumer:
 *   1. resolves the `CodeIndex` Port at its own call boundary instead of
 *      doing its own file discovery;
 *   2. with the default `none` implementation, produces byte-identical
 *      output to its pre-CodeIndex sibling function;
 *   3. with a stub `CodeIndex` returning real hits, demonstrably uses them;
 *   4. never imports the `codegraph` implementation module directly.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { overlapScore, overlapScoreWithCodeIndex } from '../../../lib/overlap-scorer'
import { buildIndexCard, buildIndexCardWithCodeIndex } from '../../../lib/index-card/build'
import {
  validateSliceReferences,
  validateSliceReferencesWithCodeIndex,
} from '../../../../workflows/slice-reference-validator'
import { noneCodeIndex } from '../none'
import type { CodeIndex, SymbolHit } from '../types'

const REPO_ROOT = resolve(__dirname, '../../../../../..')

// ---------------------------------------------------------------------------
// Stub CodeIndex builders
// ---------------------------------------------------------------------------

const hit = (name: string, filePath: string): SymbolHit => ({
  name,
  kind: 'function',
  filePath,
  startLine: 1,
})

/** A stub CodeIndex whose `search`/`symbols` return canned hits keyed by term. */
function stubCodeIndex(bySearchTerm: Record<string, SymbolHit[]>): CodeIndex {
  return {
    kind: 'stub',
    async symbols(query) {
      return bySearchTerm[query.term] ?? []
    },
    async search(query) {
      return bySearchTerm[query.term] ?? []
    },
    async impact(query) {
      return { symbol: query.symbol, affected: [] }
    },
  }
}

// ---------------------------------------------------------------------------
// overlapScoreWithCodeIndex
// ---------------------------------------------------------------------------

describe('overlapScoreWithCodeIndex', () => {
  it('with impl=none, matches overlapScore exactly', async () => {
    const a = 'fix the login form validation bug'
    const b = 'login form validation is broken'
    const withNone = await overlapScoreWithCodeIndex(a, b, noneCodeIndex)
    expect(withNone).toBe(overlapScore(a, b))
  })

  it('with a stub CodeIndex sharing a file across both terms, boosts above the base score', async () => {
    const a = 'refactor the auth module'
    const b = 'update auth logic'
    const base = overlapScore(a, b)
    const stub = stubCodeIndex({
      [a]: [hit('login', 'src/auth/login.ts')],
      [b]: [hit('login', 'src/auth/login.ts')],
    })
    const boosted = await overlapScoreWithCodeIndex(a, b, stub)
    expect(boosted).toBeGreaterThan(base)
    expect(boosted).toBeLessThanOrEqual(1)
  })

  it('with a stub CodeIndex returning hits that share no files, falls back to the base score', async () => {
    const a = 'totally unrelated text one'
    const b = 'totally unrelated text two'
    const stub = stubCodeIndex({
      [a]: [hit('foo', 'src/foo.ts')],
      [b]: [hit('bar', 'src/bar.ts')],
    })
    const result = await overlapScoreWithCodeIndex(a, b, stub)
    expect(result).toBe(overlapScore(a, b))
  })
})

// ---------------------------------------------------------------------------
// buildIndexCardWithCodeIndex
// ---------------------------------------------------------------------------

describe('buildIndexCardWithCodeIndex', () => {
  // 6 glossary terms whose words never substring-match `files`, so the
  // plain heuristic scores every one of them 0 and MAX_POINTERS=5 selection
  // falls back to an ascending id tie-break: g-a..g-e survive, g-f is cut.
  const glossary = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => ({
    id: `g-${letter}`,
    term: `zzzterm${letter}`,
    definition: `definition for g-${letter}`,
  }))

  const baseInput = {
    taskId: 'task-1',
    commitSha: 'abc123',
    files: ['src/unrelated-file.ts'],
    glossary,
    adrs: [],
    coChanges: [],
  }

  it('with impl=none, matches buildIndexCard exactly', async () => {
    const withNone = await buildIndexCardWithCodeIndex(baseInput, noneCodeIndex)
    const plain = buildIndexCard(baseInput)
    expect(withNone).toEqual(plain)
    // g-f loses the ascending id tie-break against g-a..g-e and is cut.
    expect(plain.text).not.toContain('g-f')
    expect(plain.text).toContain('g-e')
  })

  it('with a stub CodeIndex confirming g-f against the file shortlist, it displaces the lowest-ranked tied pointer', async () => {
    const stub = stubCodeIndex({
      zzztermf: [hit('someSymbol', 'src/unrelated-file.ts')],
    })
    const result = await buildIndexCardWithCodeIndex(baseInput, stub)
    // Boosted above the 0-score ties, g-f now makes the cut...
    expect(result.text).toContain('g-f')
    // ...displacing g-e, the last surviving 0-score entry.
    expect(result.text).not.toContain('g-e')
  })
})

// ---------------------------------------------------------------------------
// validateSliceReferencesWithCodeIndex
// ---------------------------------------------------------------------------

describe('validateSliceReferencesWithCodeIndex', () => {
  const slice = {
    prescriptiveAction: 'Call `someInventedSymbolXyz` to do the thing.',
    readFirst: ['orchestrator/src/workflows/slice-reference-validator.ts'],
  }

  it('with impl=none, matches validateSliceReferences exactly', async () => {
    const withNone = await validateSliceReferencesWithCodeIndex(slice, REPO_ROOT, noneCodeIndex)
    const plain = validateSliceReferences(slice, REPO_ROOT)
    expect(withNone).toEqual(plain)
  })

  it('with a stub CodeIndex confirming the symbol, it is no longer missing', async () => {
    const stub = stubCodeIndex({
      someInventedSymbolXyz: [hit('someInventedSymbolXyz', 'src/made-up.ts')],
    })
    const result = await validateSliceReferencesWithCodeIndex(slice, REPO_ROOT, stub)
    expect(result.missingSymbols).not.toContain('someInventedSymbolXyz')
  })

  it('without a code index confirming it, the fabricated symbol is still missing (rg fallback unchanged)', async () => {
    const result = await validateSliceReferencesWithCodeIndex(slice, REPO_ROOT, noneCodeIndex)
    expect(result.missingSymbols).toContain('someInventedSymbolXyz')
  })
})

// ---------------------------------------------------------------------------
// No consumer imports the codegraph implementation directly
// ---------------------------------------------------------------------------

describe('consumers never import the codegraph implementation directly', () => {
  const consumerFiles = [
    'src/core/lib/overlap-scorer.ts',
    'src/core/lib/index-card/build.ts',
    'src/workflows/slice-reference-validator.ts',
  ]

  it.each(consumerFiles)('%s only references the CodeIndex Port surface', (relPath) => {
    const source = readFileSync(resolve(REPO_ROOT, 'orchestrator', relPath), 'utf8')
    expect(source).not.toMatch(/from ['"].*ports\/code-index\/codegraph['"]/)
    expect(source).toMatch(/from ['"].*ports\/code-index\/registry['"]/)
  })
})
