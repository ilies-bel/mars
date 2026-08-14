/**
 * Tests for buildIndexCard (PRD 74d76a78 Phase 4A, slice 1 of 6).
 *
 * Coverage:
 *  - Golden fixture: fixed inputs → exact text snapshot + token budget ≤ 2000.
 *  - Determinism: same inputs → same cacheKey; different commitSha → different key.
 *  - Token budget: large inputs are trimmed; card.tokens ≤ 2000 after trim.
 *  - Relevance heuristic: file-path-matched entries rank above unmatched ones.
 *  - Pointer cap: at most 5 pointers even with many candidates.
 *  - staleAsOf: equals commitSha.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildIndexCard,
  type AdrEntry,
  type CoChange,
  type GlossaryEntry,
  type IndexCardInput,
} from './build.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Golden fixture inputs — MUST NOT change without regenerating basic.txt
// ---------------------------------------------------------------------------

const GOLDEN_TASK_ID = 'mars-test-task'
const GOLDEN_COMMIT = 'abc1234567890abcdef1234567890abcdef123456'

const GOLDEN_FILES: string[] = [
  'orchestrator/src/core/lib/index-card/build.ts',
  'orchestrator/src/core/queue.ts',
  'orchestrator/src/workflows/primitives/shared.ts',
]

const GOLDEN_GLOSSARY: GlossaryEntry[] = [
  { id: 'task', term: 'task', definition: 'A unit of work tracked in the queue.' },
  {
    id: 'arc-digest',
    term: 'arc digest',
    definition: 'Mechanical LLM-free digest of task conversations.',
  },
  { id: 'worker', term: 'worker', definition: 'A headless coding agent process.' },
]

const GOLDEN_ADRS: AdrEntry[] = [
  {
    id: 'adr-0001',
    title: 'Queue schema design',
    body: 'The task queue uses PostgreSQL.',
  },
  {
    id: 'adr-0056',
    title: 'Workflow primitives surface',
    body: 'ADR-0056: step-primitive surface for git operations.',
  },
]

const GOLDEN_COCHANGES: CoChange[] = [
  { a: 'orchestrator/src/core/queue.ts', b: 'orchestrator/src/core/lib/db.ts' },
]

const goldenInput = (): IndexCardInput => ({
  taskId: GOLDEN_TASK_ID,
  commitSha: GOLDEN_COMMIT,
  files: GOLDEN_FILES,
  glossary: GOLDEN_GLOSSARY,
  adrs: GOLDEN_ADRS,
  coChanges: GOLDEN_COCHANGES,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildIndexCard — golden fixture', () => {
  it('produces text that matches the checked-in snapshot exactly', () => {
    const fixturePath = join(__dirname, '__fixtures__', 'basic.txt')
    const expected = readFileSync(fixturePath, 'utf8')
    const card = buildIndexCard(goldenInput())
    expect(card.text).toBe(expected)
  })

  it('token count is ≤ 2000 on the golden fixture', () => {
    const card = buildIndexCard(goldenInput())
    expect(card.tokens).toBeLessThanOrEqual(2000)
    // Also verify the estimator formula: Math.ceil(text.length / 4)
    expect(card.tokens).toBe(Math.ceil(card.text.length / 4))
  })
})

describe('buildIndexCard — cacheKey', () => {
  it('returns the same cacheKey for identical inputs', () => {
    const a = buildIndexCard(goldenInput())
    const b = buildIndexCard(goldenInput())
    expect(a.cacheKey).toBe(b.cacheKey)
  })

  it('returns a different cacheKey when commitSha changes', () => {
    const original = buildIndexCard(goldenInput())
    const changed = buildIndexCard({ ...goldenInput(), commitSha: 'deadbeef' })
    expect(changed.cacheKey).not.toBe(original.cacheKey)
  })

  it('returns a different cacheKey when files change', () => {
    const original = buildIndexCard(goldenInput())
    const changed = buildIndexCard({
      ...goldenInput(),
      files: [...GOLDEN_FILES, 'orchestrator/src/extra.ts'],
    })
    expect(changed.cacheKey).not.toBe(original.cacheKey)
  })

  it('returns the same cacheKey regardless of input file order', () => {
    const a = buildIndexCard({ ...goldenInput(), files: [...GOLDEN_FILES] })
    const b = buildIndexCard({
      ...goldenInput(),
      files: [...GOLDEN_FILES].reverse(),
    })
    expect(a.cacheKey).toBe(b.cacheKey)
  })
})

describe('buildIndexCard — staleAsOf', () => {
  it('equals the commitSha', () => {
    const card = buildIndexCard(goldenInput())
    expect(card.staleAsOf).toBe(GOLDEN_COMMIT)
  })
})

describe('buildIndexCard — token budget', () => {
  it('trims large inputs to ≤ 2000 tokens and appends a trim marker', () => {
    // 200 files × ~57 chars per line ≈ 11 400 chars in the files section alone,
    // which is ~2 850 tokens — well over the 2 000-token budget.
    const manyFiles = Array.from({ length: 200 }, (_, i) => `orchestrator/src/core/lib/module-${i}/implementation.ts`)
    const card = buildIndexCard({
      taskId: 'large-task',
      commitSha: 'def456',
      files: manyFiles,
      glossary: [],
      adrs: [],
      coChanges: [],
    })
    expect(card.tokens).toBeLessThanOrEqual(2000)
    expect(card.text).toContain('…[trimmed]')
  })

  it('returns a card with tokens ≤ 2000 for the golden fixture (no trim needed)', () => {
    const card = buildIndexCard(goldenInput())
    expect(card.text).not.toContain('…[trimmed]')
    expect(card.tokens).toBeLessThanOrEqual(2000)
  })
})

describe('buildIndexCard — relevance heuristic', () => {
  it('ranks file-path-matched entries above unmatched ones', () => {
    const input: IndexCardInput = {
      taskId: 'relevance-test',
      commitSha: 'cafebabe',
      files: ['orchestrator/src/core/queue.ts'],
      glossary: [
        { id: 'unrelated', term: 'unrelated', definition: 'Nothing to do with files.' },
        { id: 'queue', term: 'queue', definition: 'The task queue is PostgreSQL-backed.' },
      ],
      adrs: [],
      coChanges: [],
    }
    const card = buildIndexCard(input)
    // 'queue' matches 'queue.ts'; 'unrelated' does not. 'queue' should appear first.
    const queueIdx = card.text.indexOf('[glossary] queue:')
    const unrelatedIdx = card.text.indexOf('[glossary] unrelated:')
    expect(queueIdx).toBeGreaterThanOrEqual(0)
    expect(unrelatedIdx).toBeGreaterThanOrEqual(0)
    expect(queueIdx).toBeLessThan(unrelatedIdx)
  })

  it('uses id as a stable tie-breaker when scores are equal', () => {
    // All glossary entries have the same (zero) score — none match any file path.
    const input: IndexCardInput = {
      taskId: 'tiebreak-test',
      commitSha: 'badc0de',
      files: ['orchestrator/src/core/unrelated.ts'],
      glossary: [
        { id: 'zzz-last', term: 'zzz last', definition: 'Last alphabetically.' },
        { id: 'aaa-first', term: 'aaa first', definition: 'First alphabetically.' },
      ],
      adrs: [],
      coChanges: [],
    }
    const card = buildIndexCard(input)
    const firstIdx = card.text.indexOf('[glossary] aaa-first:')
    const lastIdx = card.text.indexOf('[glossary] zzz-last:')
    expect(firstIdx).toBeGreaterThanOrEqual(0)
    expect(lastIdx).toBeGreaterThanOrEqual(0)
    expect(firstIdx).toBeLessThan(lastIdx)
  })
})

describe('buildIndexCard — pointer cap', () => {
  it('includes at most 5 pointers even with many candidates', () => {
    const manyGlossary: GlossaryEntry[] = Array.from({ length: 8 }, (_, i) => ({
      id: `term-${i}`,
      term: `term ${i}`,
      definition: `Definition for term ${i}.`,
    }))
    const manyAdrs: AdrEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: `adr-${String(i).padStart(4, '0')}`,
      title: `ADR ${i} title`,
      body: `Body for ADR ${i}.`,
    }))
    const card = buildIndexCard({
      taskId: 'cap-test',
      commitSha: 'cafef00d',
      files: ['orchestrator/src/core/misc.ts'],
      glossary: manyGlossary,
      adrs: manyAdrs,
      coChanges: [],
    })
    // Count pointer lines: each starts with '  [adr]' or '  [glossary]'
    const pointerLines = card.text
      .split('\n')
      .filter((l) => /^\s{2}\[(adr|glossary)\]/.test(l))
    expect(pointerLines.length).toBeLessThanOrEqual(5)
  })
})
