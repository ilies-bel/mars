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

describe('co-located improvement recipe coverage', () => {
  it('includes add-typecheck recipe with correct shape', () => {
    const recipes = loadImprovementRecipes()
    const recipe = recipes.find((r) => r.id === 'add-typecheck')
    expect(recipe).toBeDefined()
    expect(recipe!.maturityLevel).toBe('typecheck')
    expect(recipe!.verifyGate).toEqual({
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
    })
  })

  it('includes add-unit-tests recipe with npm test gate', () => {
    const recipes = loadImprovementRecipes()
    const recipe = recipes.find((r) => r.id === 'add-unit-tests')
    expect(recipe).toBeDefined()
    expect(recipe!.maturityLevel).toBe('tests')
    expect(recipe!.verifyGate).toEqual({ name: 'test', cmd: 'npm', args: ['test'] })
  })

  it('includes add-lint recipe with eslint gate', () => {
    const recipes = loadImprovementRecipes()
    const recipe = recipes.find((r) => r.id === 'add-lint')
    expect(recipe).toBeDefined()
    expect(recipe!.maturityLevel).toBe('tests')
    expect(recipe!.verifyGate).toEqual({ name: 'lint', cmd: 'npx', args: ['eslint', '.'] })
  })

  it('includes add-e2e recipe with playwright gate and setup steps', () => {
    const recipes = loadImprovementRecipes()
    const recipe = recipes.find((r) => r.id === 'add-e2e')
    expect(recipe).toBeDefined()
    expect(recipe!.maturityLevel).toBe('e2e')
    expect(recipe!.verifyGate).toEqual({ name: 'e2e', cmd: 'npx', args: ['playwright', 'test'] })
    expect(recipe!.setupSteps.length).toBeGreaterThan(0)
    const steps = recipe!.setupSteps.join(' ')
    expect(steps).toContain('playwright')
    expect(steps).toContain('mars credentials set')
  })

  it('includes add-integration-tests recipe with no verifyGate', () => {
    const recipes = loadImprovementRecipes()
    const recipe = recipes.find((r) => r.id === 'add-integration-tests')
    expect(recipe).toBeDefined()
    expect(recipe!.maturityLevel).toBe('tests')
    expect(recipe!.verifyGate).toBeUndefined()
  })

  it('includes add-sso-credentials recipe guiding through credentials setup', () => {
    const recipes = loadImprovementRecipes()
    const recipe = recipes.find((r) => r.id === 'add-sso-credentials')
    expect(recipe).toBeDefined()
    expect(recipe!.maturityLevel).toBe('e2e')
    const steps = recipe!.setupSteps.join(' ')
    expect(steps).toContain('mars credentials set')
    expect(steps).toContain('storageState')
  })

  it('every recipe has required non-empty string fields', () => {
    const recipes = loadImprovementRecipes()
    for (const r of recipes) {
      expect(typeof r.id).toBe('string')
      expect(r.id.length).toBeGreaterThan(0)
      expect(typeof r.name).toBe('string')
      expect(r.name.length).toBeGreaterThan(0)
      expect(typeof r.triggerPattern).toBe('string')
      expect(r.triggerPattern.length).toBeGreaterThan(0)
      expect(typeof r.problem).toBe('string')
      expect(r.problem.length).toBeGreaterThan(0)
      expect(typeof r.solution).toBe('string')
      expect(r.solution.length).toBeGreaterThan(0)
      expect(Array.isArray(r.setupSteps)).toBe(true)
    }
  })

  it('returns a new array each call (catalog is not mutated)', () => {
    const a = loadImprovementRecipes()
    const b = loadImprovementRecipes()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it('renders each recipe id in the output', () => {
    const recipes = loadImprovementRecipes()
    const output = formatRecipeCatalog(recipes)
    for (const r of recipes) {
      expect(output).toContain(r.id)
    }
  })

  it('renders the recipe name as a heading', () => {
    const recipes = loadImprovementRecipes()
    const output = formatRecipeCatalog(recipes)
    for (const r of recipes) {
      expect(output).toContain(`### ${r.name}`)
    }
  })

  it('renders maturity level for each recipe', () => {
    const recipes = loadImprovementRecipes()
    const output = formatRecipeCatalog(recipes)
    expect(output).toContain('typecheck')
    expect(output).toContain('e2e')
  })

  it('renders verify gate command for recipes that have one', () => {
    const recipes = loadImprovementRecipes()
    const output = formatRecipeCatalog(recipes)
    // add-typecheck has `npx tsc --noEmit`
    expect(output).toContain('npx tsc --noEmit')
    // add-e2e has `npx playwright test`
    expect(output).toContain('npx playwright test')
  })

  it('does not emit a verify gate line for recipes without one', () => {
    const integrationRecipe = loadImprovementRecipes().find(
      (r) => r.id === 'add-integration-tests',
    )!
    const output = formatRecipeCatalog([integrationRecipe])
    // Should NOT contain "Verify gate:" for this recipe
    expect(output).not.toContain('**Verify gate:**')
  })

  it('renders setup steps as a bullet list', () => {
    const e2eRecipe = loadImprovementRecipes().find((r) => r.id === 'add-e2e')!
    const output = formatRecipeCatalog([e2eRecipe])
    for (const step of e2eRecipe.setupSteps) {
      expect(output).toContain(`- ${step}`)
    }
  })

  it('returns a placeholder when given an empty array', () => {
    const output = formatRecipeCatalog([])
    expect(output).toContain('no improvement recipes')
  })

  it('works with a single custom recipe', () => {
    const custom: ImprovementRecipe = {
      id: 'custom-gate',
      name: 'Custom gate',
      triggerPattern: 'When custom',
      problem: 'Custom problem',
      solution: 'Custom solution',
      setupSteps: ['Do step one', 'Do step two'],
      verifyGate: { name: 'custom', cmd: 'npm', args: ['run', 'custom'], scope: 'unit' },
      maturityLevel: 'tests',
    }
    const output = formatRecipeCatalog([custom])
    expect(output).toContain('custom-gate')
    expect(output).toContain('Custom gate')
    expect(output).toContain('npm run custom')
    expect(output).toContain('scope: unit')
    expect(output).toContain('- Do step one')
    expect(output).toContain('- Do step two')
  })
})
