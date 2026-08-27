import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LeverRegistryEntry } from '../../core/lib/lever-registry.js'

// ---------------------------------------------------------------------------
// Fixture: four lever-registry entries that carry a verifyGate field, matching
// the real registry shape but decoupled from production data so tests are
// stable even if the registry grows or changes.
// ---------------------------------------------------------------------------

const makeEntry = (
  id: string,
  gateName: string,
  maturityLevel: 'bare' | 'typecheck' | 'tests' | 'e2e',
  predicate?: (repoRoot: string) => boolean,
): LeverRegistryEntry => ({
  id,
  label: id,
  family: 'verify',
  scope: 'global',
  readCurrent: () => null,
  allowedValues: { type: 'freeform' },
  gesture: null,
  appliesWithoutRestart: true,
  recipe: {
    triggerPattern: '',
    problem: `Repo has files but no ${gateName} gate.`,
    solution: '',
    setupSteps: [],
    verifyGate: { name: gateName, cmd: 'npx', args: [] },
    maturityLevel,
    predicate,
  },
})

/** One non-recipe entry to confirm it is always excluded. */
const noRecipeEntry: LeverRegistryEntry = {
  id: 'caps.implement',
  label: 'Maximum concurrent implement slots',
  family: 'concurrency',
  scope: 'global',
  readCurrent: () => '12',
  allowedValues: { type: 'range', min: 1 },
  gesture: 'mars daemon set-cap implement <n>',
  appliesWithoutRestart: true,
}

/** Entry with a recipe but no verifyGate (e.g. verify.add-sso-credentials). */
const recipeNoGateEntry: LeverRegistryEntry = {
  id: 'verify.add-sso-credentials',
  label: 'Add SSO credential injection',
  family: 'verify',
  scope: 'global',
  readCurrent: () => null,
  allowedValues: { type: 'freeform' },
  gesture: null,
  appliesWithoutRestart: true,
  recipe: {
    triggerPattern: '',
    problem: '',
    solution: '',
    setupSteps: [],
    maturityLevel: 'e2e',
    // no verifyGate field
  },
}

const typecheckEntry = makeEntry('verify.add-typecheck', 'typecheck', 'typecheck')
const unitTestEntry  = makeEntry('verify.add-unit-tests', 'test', 'tests')
const lintEntry      = makeEntry('verify.add-lint', 'lint', 'tests')
const e2eEntry       = makeEntry('verify.add-e2e', 'e2e', 'e2e')

const FIXTURE_REGISTRY: LeverRegistryEntry[] = [
  noRecipeEntry,
  recipeNoGateEntry,
  typecheckEntry,
  unitTestEntry,
  lintEntry,
  e2eEntry,
]

vi.mock('../../core/lib/lever-registry.js', () => ({
  loadLeverRegistry: () => [...FIXTURE_REGISTRY],
}))

// Import the module under test AFTER the mock is registered.
const { computeMissingGates } = await import('../compute-missing-gates.js')

// ---------------------------------------------------------------------------
// Tests — existing behaviour (no repoRoot → predicates not evaluated)
// ---------------------------------------------------------------------------

describe('computeMissingGates', () => {
  it('returns all gated entries when the detected set is empty', () => {
    const { entries } = computeMissingGates([])
    // Must include every entry that carries a verifyGate; non-gated entries excluded.
    expect(entries.map((e) => e.id)).toEqual([
      'verify.add-typecheck',
      'verify.add-unit-tests',
      'verify.add-lint',
      'verify.add-e2e',
    ])
  })

  it('sorts by maturity priority: typecheck first, then tests, then e2e', () => {
    const { entries } = computeMissingGates([])
    const maturity = entries.map((e) => e.recipe!.maturityLevel)
    expect(maturity).toEqual(['typecheck', 'tests', 'tests', 'e2e'])
  })

  it('excludes the matching entry when a detected gate named "test" is present', () => {
    const { entries } = computeMissingGates([{ name: 'test' }])
    const ids = entries.map((e) => e.id)
    expect(ids).not.toContain('verify.add-unit-tests')
    // The other three gated entries are still missing.
    expect(ids).toContain('verify.add-typecheck')
    expect(ids).toContain('verify.add-lint')
    expect(ids).toContain('verify.add-e2e')
  })

  it('returns an empty array when all four gated recipes are detected', () => {
    const detected = [
      { name: 'typecheck' },
      { name: 'test' },
      { name: 'lint' },
      { name: 'e2e' },
    ]
    const { entries } = computeMissingGates(detected)
    expect(entries).toEqual([])
  })

  it('matches by gate name only — cmd/args differences are ignored', () => {
    // A detected gate named 'lint' regardless of its cmd or args is considered present.
    const { entries } = computeMissingGates([{ name: 'lint', cmd: 'biome', args: ['check'] } as { name: string }])
    expect(entries.map((e) => e.id)).not.toContain('verify.add-lint')
  })

  it('handles a partial detected set correctly', () => {
    // Only typecheck is present; test, lint, e2e are still missing.
    const { entries } = computeMissingGates([{ name: 'typecheck' }])
    const ids = entries.map((e) => e.id)
    expect(ids).not.toContain('verify.add-typecheck')
    expect(ids).toContain('verify.add-unit-tests')
    expect(ids).toContain('verify.add-lint')
    expect(ids).toContain('verify.add-e2e')
  })

  it('never includes non-recipe or recipe-without-verifyGate entries', () => {
    const { entries } = computeMissingGates([])
    const ids = entries.map((e) => e.id)
    expect(ids).not.toContain('caps.implement')
    expect(ids).not.toContain('verify.add-sso-credentials')
  })

  it('returns isFallback: false when no repoRoot is given', () => {
    expect(computeMissingGates([]).isFallback).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Predicate-filtering tests — use real lever registry via vi.doMock reset
// ---------------------------------------------------------------------------
// These tests exercise the production typecheck predicate (hasTypescriptEvidence)
// against real temporary directories, verifying the regression guard from HR-8.

describe('computeMissingGates — predicate-based filtering (real registry)', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.resetModules()
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-cmg-pred-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /**
   * Helper: import the real computeMissingGates backed by the real lever registry.
   * Must be called AFTER vi.resetModules() and vi.doMock() setup, hence async.
   */
  async function realComputeMissingGates() {
    vi.doMock('../../core/lib/lever-registry.js', async () =>
      vi.importActual('../../core/lib/lever-registry.js'),
    )
    return (await import('../compute-missing-gates.js')).computeMissingGates
  }

  it('offers the typecheck recipe when tsconfig.json exists', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}')
    const fn = await realComputeMissingGates()
    const { entries } = fn([], tmpDir)
    expect(entries.map((e) => e.id)).toContain('verify.add-typecheck')
    expect(entries.find((e) => e.id === 'verify.add-typecheck')).toBeDefined()
  })

  it('offers the typecheck recipe when typescript is in devDependencies (no tsconfig.json)', async () => {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }),
    )
    const fn = await realComputeMissingGates()
    const { entries } = fn([], tmpDir)
    expect(entries.map((e) => e.id)).toContain('verify.add-typecheck')
  })

  it('does not offer typecheck outside the fallback path for a JS-only repo', async () => {
    // A bare JS repo has no TypeScript, no test files, no linter, no playwright —
    // ALL predicates fail. The DEC-15 fallback kicks in (isFallback: true), which
    // means typecheck's predicate correctly returned false (no false positive match).
    writeFileSync(join(tmpDir, 'index.js'), 'module.exports = {}')
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js' } }))
    const fn = await realComputeMissingGates()
    const { isFallback } = fn([], tmpDir)
    // isFallback: true confirms no predicate matched — hasTypescriptEvidence returned
    // false, as did all other recipe predicates. Any non-fallback result would imply
    // a false-positive predicate match.
    expect(isFallback).toBe(true)
  })

  it('still returns a non-empty list when all predicates fail (DEC-15 guard)', async () => {
    // A bare JS repo — no TypeScript, no tests, no linter, no playwright — causes
    // all recipe predicates to fail. The DEC-15 fallback returns the full
    // maturity-ordered list so onboarding always has a gate to dispatch.
    writeFileSync(join(tmpDir, 'index.js'), 'module.exports = {}')
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }))
    const fn = await realComputeMissingGates()
    const { entries, isFallback } = fn([], tmpDir)
    expect(entries.length).toBeGreaterThan(0)
    expect(isFallback).toBe(true)
  })

  it('sets isFallback: false when at least one predicate matches', async () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}')
    const fn = await realComputeMissingGates()
    const { isFallback } = fn([], tmpDir)
    expect(isFallback).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fallback tests — fixture registry where ALL entries have failing predicates
// ---------------------------------------------------------------------------

describe('computeMissingGates — no-match fallback (DEC-15)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sets isFallback: true and returns maturity-ordered entries when all predicates fail', async () => {
    // A registry where all entries have predicates that always return false.
    const alwaysFalse = () => false
    const allPredicatedRegistry: LeverRegistryEntry[] = [
      makeEntry('verify.add-typecheck', 'typecheck', 'typecheck', alwaysFalse),
      makeEntry('verify.add-unit-tests', 'test', 'tests', alwaysFalse),
      makeEntry('verify.add-e2e', 'e2e', 'e2e', alwaysFalse),
    ]
    vi.doMock('../../core/lib/lever-registry.js', () => ({
      loadLeverRegistry: () => [...allPredicatedRegistry],
    }))
    const { computeMissingGates: fn } = await import('../compute-missing-gates.js')
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-cmg-fallback-'))
    try {
      const { entries, isFallback } = fn([], tmpDir)
      expect(isFallback).toBe(true)
      // Maturity ordering preserved: typecheck < tests < e2e
      expect(entries.map((e) => e.id)).toEqual([
        'verify.add-typecheck',
        'verify.add-unit-tests',
        'verify.add-e2e',
      ])
      expect(entries.length).toBeGreaterThan(0)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns isFallback: false when at least one entry has no predicate', async () => {
    // One entry has no predicate → always applicable → no fallback
    const mixedRegistry: LeverRegistryEntry[] = [
      makeEntry('verify.add-typecheck', 'typecheck', 'typecheck', () => false),
      makeEntry('verify.add-unit-tests', 'test', 'tests'), // no predicate
    ]
    vi.doMock('../../core/lib/lever-registry.js', () => ({
      loadLeverRegistry: () => [...mixedRegistry],
    }))
    const { computeMissingGates: fn } = await import('../compute-missing-gates.js')
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-cmg-fallback2-'))
    try {
      const { isFallback } = fn([], tmpDir)
      expect(isFallback).toBe(false)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// build-gate-task-prompt fallback path: neutral problem statement
// ---------------------------------------------------------------------------

describe('buildGateTaskPrompt — fallback problem statement', () => {
  it('emits a neutral problem statement on the fallback path', async () => {
    const { buildGateTaskPrompt } = await import('../build-gate-task-prompt.js')
    const entry = makeEntry('verify.add-typecheck', 'typecheck', 'typecheck')
    const { prompt } = buildGateTaskPrompt(entry, { isFallback: true })
    // The neutral statement must NOT claim anything about the repo's contents.
    expect(prompt).not.toContain('Your repo has TypeScript files')
    expect(prompt).not.toContain('TypeScript files')
    // It should describe the missing gate, not a repo property.
    expect(prompt).toContain('No typecheck gate is configured')
  })

  it('uses the recipe problem text on the normal (non-fallback) path', async () => {
    const { buildGateTaskPrompt } = await import('../build-gate-task-prompt.js')
    const entry = makeEntry('verify.add-typecheck', 'typecheck', 'typecheck')
    // The fixture problem is 'Repo has files but no typecheck gate.'
    const { prompt } = buildGateTaskPrompt(entry, { isFallback: false })
    expect(prompt).toContain('Repo has files but no typecheck gate.')
  })
})

// ---------------------------------------------------------------------------
// Table-driven registry invariant — every recipe that asserts a repo property
// must carry a predicate (HR-8 regression guard).
// ---------------------------------------------------------------------------
// This is the most important guard in the file: it ensures a future recipe
// cannot silently assert "Your repo has X" without a predicate that checks X.

describe('lever registry — predicate completeness invariant (table-driven)', () => {
  /**
   * Pattern that detects a second-person repo-property claim in a recipe's
   * problem string. Any problem sentence that begins with "Your repo has"
   * asserts a specific property of the operator's repo and therefore requires
   * a predicate so the assertion is actually checked before the recipe is
   * offered.
   */
  const REPO_CLAIM_PATTERN = /Your repo has\b/i

  it('every recipe whose problem text makes a second-person repo claim carries a predicate', async () => {
    vi.resetModules()
    vi.doMock('../../core/lib/lever-registry.js', async () =>
      vi.importActual('../../core/lib/lever-registry.js'),
    )
    const { loadLeverRegistry } = await import('../../core/lib/lever-registry.js')
    const registry = loadLeverRegistry()

    const violations: string[] = []
    for (const entry of registry) {
      if (!entry.recipe) continue
      if (!REPO_CLAIM_PATTERN.test(entry.recipe.problem)) continue
      if (!entry.recipe.predicate) {
        violations.push(
          `${entry.id}: problem asserts "${entry.recipe.problem.slice(0, 60)}…" but has no predicate`,
        )
      }
    }

    expect(violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Direct predicate tests — each new predicate against real temp directories
// ---------------------------------------------------------------------------

describe('computeMissingGates — unit-test, lint, and e2e predicate filtering (real registry)', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.resetModules()
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-cmg-preds-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function realComputeMissingGates() {
    vi.doMock('../../core/lib/lever-registry.js', async () =>
      vi.importActual('../../core/lib/lever-registry.js'),
    )
    return (await import('../compute-missing-gates.js')).computeMissingGates
  }

  // ── unit-test predicate ──────────────────────────────────────────────────

  it('offers the unit-test recipe when a test/ directory exists', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(tmpDir, 'test'))
    const fn = await realComputeMissingGates()
    const { entries, isFallback } = fn([], tmpDir)
    expect(isFallback).toBe(false)
    expect(entries.map((e) => e.id)).toContain('verify.add-unit-tests')
  })

  it('does not offer the unit-test recipe for a repo with no test evidence', async () => {
    // A repo with neither a test directory nor a test script nor test files.
    writeFileSync(join(tmpDir, 'index.js'), 'module.exports = {}')
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }))
    const fn = await realComputeMissingGates()
    const { isFallback } = fn([], tmpDir)
    // All predicates fail → DEC-15 fallback. The fallback confirms no test
    // evidence was found (otherwise some predicate would have matched).
    expect(isFallback).toBe(true)
  })

  // ── lint predicate ───────────────────────────────────────────────────────

  it('offers the lint recipe when .eslintrc.json exists', async () => {
    writeFileSync(join(tmpDir, '.eslintrc.json'), '{"root":true}')
    const fn = await realComputeMissingGates()
    const { entries, isFallback } = fn([], tmpDir)
    expect(isFallback).toBe(false)
    expect(entries.map((e) => e.id)).toContain('verify.add-lint')
  })

  it('does not offer the lint recipe for a repo with no linter evidence', async () => {
    writeFileSync(join(tmpDir, 'index.js'), 'module.exports = {}')
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }))
    const fn = await realComputeMissingGates()
    const { isFallback } = fn([], tmpDir)
    expect(isFallback).toBe(true)
  })

  // ── e2e predicate ────────────────────────────────────────────────────────

  it('offers the e2e recipe when playwright.config.ts exists', async () => {
    writeFileSync(join(tmpDir, 'playwright.config.ts'), 'export default {}')
    const fn = await realComputeMissingGates()
    const { entries, isFallback } = fn([], tmpDir)
    expect(isFallback).toBe(false)
    expect(entries.map((e) => e.id)).toContain('verify.add-e2e')
  })

  it('does not offer the e2e recipe for a repo with no playwright evidence', async () => {
    writeFileSync(join(tmpDir, 'index.js'), 'module.exports = {}')
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ scripts: {} }))
    const fn = await realComputeMissingGates()
    const { isFallback } = fn([], tmpDir)
    expect(isFallback).toBe(true)
  })

  // ── DEC-15 fallback with all new predicates ──────────────────────────────

  it('yields isFallback: true and non-empty entries when no predicate matches (DEC-15 with all predicates)', async () => {
    // Bare repo — no TypeScript, no tests, no linter, no playwright.
    writeFileSync(join(tmpDir, 'index.js'), 'module.exports = {}')
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'bare-repo' }))
    const fn = await realComputeMissingGates()
    const { entries, isFallback } = fn([], tmpDir)
    expect(isFallback).toBe(true)
    expect(entries.length).toBeGreaterThan(0)
  })
})
