import { describe, expect, it } from 'vitest'
import {
  formatRecipeCatalog,
  loadImprovementRecipes,
  type ImprovementRecipe,
} from '../improvement-recipes.js'

/** The six built-in recipe IDs shipped with this slice. */
const BUILT_IN_RECIPE_IDS = [
  'add-typecheck',
  'add-unit-tests',
  'add-lint',
  'add-e2e',
  'add-integration-tests',
  'add-sso-credentials',
] as const

const VALID_MATURITY_LEVELS = ['bare', 'typecheck', 'tests', 'e2e'] as const

describe('loadImprovementRecipes()', () => {
  it('returns all six built-in recipes', () => {
    const recipes = loadImprovementRecipes()
    const ids = recipes.map((r) => r.id).sort()
    expect(ids).toEqual([...BUILT_IN_RECIPE_IDS].sort())
  })

  it('every recipe has all required string fields non-empty', () => {
    const recipes = loadImprovementRecipes()
    for (const r of recipes) {
      expect(r.id.length).toBeGreaterThan(0)
      expect(r.name.length).toBeGreaterThan(0)
      expect(r.triggerPattern.length).toBeGreaterThan(0)
      expect(r.problem.length).toBeGreaterThan(0)
      expect(r.solution.length).toBeGreaterThan(0)
    }
  })

  it('every recipe has a valid maturityLevel', () => {
    const recipes = loadImprovementRecipes()
    for (const r of recipes) {
      expect(VALID_MATURITY_LEVELS).toContain(r.maturityLevel)
    }
  })

  it('every recipe has a setupSteps array (may be empty)', () => {
    const recipes = loadImprovementRecipes()
    for (const r of recipes) {
      expect(Array.isArray(r.setupSteps)).toBe(true)
    }
  })

  it('returns a defensive copy — mutations do not affect the catalog', () => {
    const first = loadImprovementRecipes()
    // Mutate the returned array.
    first.length = 0

    const second = loadImprovementRecipes()
    expect(second).toHaveLength(BUILT_IN_RECIPE_IDS.length)
  })

  describe('add-typecheck recipe', () => {
    it('has a verifyGate targeting tsc --noEmit', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-typecheck')
      expect(r).toBeDefined()
      expect(r!.verifyGate).toMatchObject({
        name: 'typecheck',
        cmd: 'npx',
        args: expect.arrayContaining(['tsc', '--noEmit']),
      })
    })

    it('has maturityLevel typecheck', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-typecheck')
      expect(r!.maturityLevel).toBe('typecheck')
    })
  })

  describe('add-unit-tests recipe', () => {
    it('has a verifyGate targeting npm test', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-unit-tests')
      expect(r).toBeDefined()
      expect(r!.verifyGate).toMatchObject({
        name: 'test',
        cmd: 'npm',
        args: expect.arrayContaining(['test']),
      })
    })

    it('has maturityLevel tests', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-unit-tests')
      expect(r!.maturityLevel).toBe('tests')
    })
  })

  describe('add-lint recipe', () => {
    it('has a verifyGate targeting eslint', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-lint')
      expect(r).toBeDefined()
      expect(r!.verifyGate).toMatchObject({
        name: 'lint',
        cmd: 'npx',
        args: expect.arrayContaining(['eslint']),
      })
    })

    it('has maturityLevel tests', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-lint')
      expect(r!.maturityLevel).toBe('tests')
    })
  })

  describe('add-e2e recipe', () => {
    it('has a verifyGate targeting playwright test', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-e2e')
      expect(r).toBeDefined()
      expect(r!.verifyGate).toMatchObject({
        name: 'e2e',
        cmd: 'npx',
        args: expect.arrayContaining(['playwright', 'test']),
      })
    })

    it('has maturityLevel e2e', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-e2e')
      expect(r!.maturityLevel).toBe('e2e')
    })

    it('has setup steps including playwright and credential instructions', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-e2e')
      const steps = r!.setupSteps.join(' ')
      // Should mention playwright and SSO credentials.
      expect(steps.toLowerCase()).toContain('playwright')
      expect(steps.toLowerCase()).toContain('credentials')
    })
  })

  describe('add-integration-tests recipe', () => {
    it('has no verifyGate (gate is configured per-repo)', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-integration-tests')
      expect(r).toBeDefined()
      expect(r!.verifyGate).toBeUndefined()
    })

    it('has maturityLevel tests', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-integration-tests')
      expect(r!.maturityLevel).toBe('tests')
    })
  })

  describe('add-sso-credentials recipe', () => {
    it('has maturityLevel e2e', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-sso-credentials')
      expect(r).toBeDefined()
      expect(r!.maturityLevel).toBe('e2e')
    })

    it('setup steps mention mars credentials set', () => {
      const r = loadImprovementRecipes().find((x) => x.id === 'add-sso-credentials')
      const steps = r!.setupSteps.join(' ')
      expect(steps).toContain('mars credentials set')
    })
  })
})

describe('formatRecipeCatalog()', () => {
  it('returns a non-empty message when given an empty array', () => {
    const output = formatRecipeCatalog([])
    expect(output.length).toBeGreaterThan(0)
  })

  it('includes each recipe id and name in the output', () => {
    const recipes = loadImprovementRecipes()
    const output = formatRecipeCatalog(recipes)
    for (const r of recipes) {
      expect(output).toContain(r.id)
      expect(output).toContain(r.name)
    }
  })

  it('renders verifyGate command for recipes that have one', () => {
    const recipes = loadImprovementRecipes()
    const output = formatRecipeCatalog(recipes)
    // add-typecheck has a verify gate with 'tsc'
    expect(output).toContain('tsc')
    // add-e2e has a verify gate with 'playwright'
    expect(output).toContain('playwright')
  })

  it('renders a subset catalog correctly when given only some recipes', () => {
    const subset: ImprovementRecipe[] = loadImprovementRecipes().filter(
      (r) => r.maturityLevel === 'e2e',
    )
    const output = formatRecipeCatalog(subset)
    expect(output).toContain('add-e2e')
    expect(output).toContain('add-sso-credentials')
    // Non-e2e recipes should not appear.
    expect(output).not.toContain('add-typecheck')
    expect(output).not.toContain('add-unit-tests')
  })

  it('output is valid markdown (has headings)', () => {
    const output = formatRecipeCatalog(loadImprovementRecipes())
    expect(output).toMatch(/^#+\s/m)
  })
})
