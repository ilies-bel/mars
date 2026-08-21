/**
 * Wiring tests for the three CodeIndex consumers (PRD ae17340a, slice 31):
 *   - overlapScore           (../../lib/overlap-scorer.ts)
 *   - buildIndexCard         (../../lib/index-card/build.ts)
 *   - validateSliceReferences (../../../workflows/slice-reference-validator.ts)
 *
 * Each consumer:
 *   1. resolves the `CodeIndex` Port at its own call boundary instead of
 *      doing its own file discovery;
 *   2. with the default `none` implementation, produces the same output as
 *      it did before this slice;
 *   3. with a stub `CodeIndex` returning real hits, demonstrably uses them;
 *   4. never imports the `codegraph` implementation module directly.
 *
 * There is deliberately no `*WithCodeIndex` sibling to compare against — the
 * Port is wired into the canonical function itself, so the `impl='none'`
 * assertions below pin the pre-slice behaviour explicitly instead.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { overlapScore, tokenize } from '../../../lib/overlap-scorer'
import { buildIndexCard } from '../../../lib/index-card/build'
import { validateSliceReferences } from '../../../../workflows/slice-reference-validator'
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
function stubCodeIndex(byTerm: Record<string, SymbolHit[]>): CodeIndex {
  return {
    kind: 'stub',
    async symbols(query) {
      return byTerm[query.term] ?? []
    },
    async search(query) {
      return byTerm[query.term] ?? []
    },
    async impact(query) {
      return { symbol: query.symbol, affected: [] }
    },
  }
}

// ---------------------------------------------------------------------------
// overlapScore
// ---------------------------------------------------------------------------

describe('overlapScore', () => {
  /**
   * The pre-slice scorer: plain Jaccard over the token sets. `impl='none'`
   * must still agree with this exactly.
   */
  const jaccard = (a: string, b: string): number => {
    const setA = new Set(tokenize(a))
    const setB = new Set(tokenize(b))
    if (setA.size === 0 || setB.size === 0) return 0
    let shared = 0
    for (const tok of setA) if (setB.has(tok)) shared++
    return shared / (setA.size + setB.size - shared)
  }

  it('with impl=none, matches the pre-slice Jaccard score exactly', async () => {
    const a = 'fix the login form validation bug'
    const b = 'login form validation is broken'
    expect(await overlapScore(a, b, noneCodeIndex)).toBe(jaccard(a, b))
  })

  it('with impl=none, an empty token set still scores 0', async () => {
    expect(await overlapScore('the and a for with', 'anything at all', noneCodeIndex)).toBe(0)
  })

  it('with a stub CodeIndex sharing a file across both terms, boosts above the base score', async () => {
    const a = 'refactor the auth module'
    const b = 'update auth logic'
    const stub = stubCodeIndex({
      [a]: [hit('login', 'src/auth/login.ts')],
      [b]: [hit('login', 'src/auth/login.ts')],
    })
    const boosted = await overlapScore(a, b, stub)
    expect(boosted).toBeGreaterThan(jaccard(a, b))
    expect(boosted).toBeLessThanOrEqual(1)
  })

  it('with a stub CodeIndex returning hits that share no files, falls back to the base score', async () => {
    const a = 'totally unrelated text one'
    const b = 'totally unrelated text two'
    const stub = stubCodeIndex({
      [a]: [hit('foo', 'src/foo.ts')],
      [b]: [hit('bar', 'src/bar.ts')],
    })
    expect(await overlapScore(a, b, stub)).toBe(jaccard(a, b))
  })
})

// ---------------------------------------------------------------------------
// buildIndexCard
// ---------------------------------------------------------------------------

describe('buildIndexCard', () => {
  // 6 glossary terms whose words never substring-match `files`, so the plain
  // heuristic scores every one of them 0 and MAX_POINTERS=5 selection falls
  // back to an ascending id tie-break: g-a..g-e survive, g-f is cut.
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

  it('with impl=none, leaves the shortlist and pointer ranking exactly as before', async () => {
    const card = await buildIndexCard(baseInput, noneCodeIndex)
    // The shortlist is untouched — no discovered files joined it.
    expect(card.text).toContain('files (1):')
    expect(card.text).toContain('- src/unrelated-file.ts')
    // g-f loses the ascending id tie-break against g-a..g-e and is cut.
    expect(card.text).toContain('g-e')
    expect(card.text).not.toContain('g-f')
  })

  it('with impl=none, the cache key is stable across builds and keyed on the shortlist', async () => {
    const first = await buildIndexCard(baseInput, noneCodeIndex)
    const second = await buildIndexCard(baseInput, noneCodeIndex)
    expect(first.cacheKey).toBe(second.cacheKey)

    const other = await buildIndexCard(
      { ...baseInput, files: ['src/some-other-file.ts'] },
      noneCodeIndex,
    )
    expect(other.cacheKey).not.toBe(first.cacheKey)
  })

  it('with a stub CodeIndex, discovered files join the shortlist and re-rank the pointers', async () => {
    // The shortlist path 'src/unrelated-file.ts' contributes the search term
    // 'unrelated-file'; the index answers with a file naming glossary term f.
    const stub = stubCodeIndex({
      'unrelated-file': [hit('someSymbol', 'src/zzztermf-impl.ts')],
    })
    const card = await buildIndexCard(baseInput, stub)

    // The returned symbol's file demonstrably joined `files[]`.
    expect(card.text).toContain('files (2):')
    expect(card.text).toContain('- src/zzztermf-impl.ts')

    // And because pointers are scored against the shortlist, g-f now
    // out-ranks the 0-score ties and displaces g-e.
    expect(card.text).toContain('g-f')
    expect(card.text).not.toContain('g-e')
  })

  it('caps the enriched shortlist so a chatty index cannot crowd out the card', async () => {
    const stub = stubCodeIndex({
      'unrelated-file': Array.from({ length: 200 }, (_, i) =>
        hit(`sym${i}`, `src/discovered-${i}.ts`),
      ),
    })
    const card = await buildIndexCard(baseInput, stub)
    expect(card.text).toContain('files (40):')
  })
})

// ---------------------------------------------------------------------------
// validateSliceReferences
// ---------------------------------------------------------------------------

describe('validateSliceReferences', () => {
  const slice = {
    prescriptiveAction: 'Call `someInventedSymbolXyz` to do the thing.',
    readFirst: ['orchestrator/src/workflows/slice-reference-validator.ts'],
  }

  it('with impl=none, the rg fallback is unchanged: the fabricated symbol is still missing', async () => {
    const result = await validateSliceReferences(slice, REPO_ROOT, noneCodeIndex)
    expect(result.missingSymbols).toContain('someInventedSymbolXyz')
    // The readFirst path really exists, so it is not reported missing.
    expect(result.missingReadFirstPaths).toEqual([])
  })

  it('with a stub CodeIndex confirming the symbol, it is no longer missing', async () => {
    const stub = stubCodeIndex({
      someInventedSymbolXyz: [hit('someInventedSymbolXyz', 'src/made-up.ts')],
    })
    const result = await validateSliceReferences(slice, REPO_ROOT, stub)
    expect(result.missingSymbols).not.toContain('someInventedSymbolXyz')
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
