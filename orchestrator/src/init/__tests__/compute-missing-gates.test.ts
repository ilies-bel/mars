import { describe, expect, it, vi } from 'vitest'
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
    problem: '',
    solution: '',
    setupSteps: [],
    verifyGate: { name: gateName, cmd: 'npx', args: [] },
    maturityLevel,
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
// Tests
// ---------------------------------------------------------------------------

describe('computeMissingGates', () => {
  it('returns all gated entries when the detected set is empty', () => {
    const result = computeMissingGates([])
    // Must include every entry that carries a verifyGate; non-gated entries excluded.
    expect(result.map((e) => e.id)).toEqual([
      'verify.add-typecheck',
      'verify.add-unit-tests',
      'verify.add-lint',
      'verify.add-e2e',
    ])
  })

  it('sorts by maturity priority: typecheck first, then tests, then e2e', () => {
    const result = computeMissingGates([])
    const maturity = result.map((e) => e.recipe!.maturityLevel)
    expect(maturity).toEqual(['typecheck', 'tests', 'tests', 'e2e'])
  })

  it('excludes the matching entry when a detected gate named "test" is present', () => {
    const result = computeMissingGates([{ name: 'test' }])
    const ids = result.map((e) => e.id)
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
    expect(computeMissingGates(detected)).toEqual([])
  })

  it('matches by gate name only — cmd/args differences are ignored', () => {
    // A detected gate named 'lint' regardless of its cmd or args is considered present.
    const result = computeMissingGates([{ name: 'lint', cmd: 'biome', args: ['check'] } as { name: string }])
    expect(result.map((e) => e.id)).not.toContain('verify.add-lint')
  })

  it('handles a partial detected set correctly', () => {
    // Only typecheck is present; test, lint, e2e are still missing.
    const result = computeMissingGates([{ name: 'typecheck' }])
    const ids = result.map((e) => e.id)
    expect(ids).not.toContain('verify.add-typecheck')
    expect(ids).toContain('verify.add-unit-tests')
    expect(ids).toContain('verify.add-lint')
    expect(ids).toContain('verify.add-e2e')
  })

  it('never includes non-recipe or recipe-without-verifyGate entries', () => {
    const result = computeMissingGates([])
    const ids = result.map((e) => e.id)
    expect(ids).not.toContain('caps.implement')
    expect(ids).not.toContain('verify.add-sso-credentials')
  })
})
