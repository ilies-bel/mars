import { describe, it, expect } from 'vitest'
import {
  loadImprovementRecipes,
  formatRecipeCatalog,
  type ImprovementRecipe,
} from './improvement-recipes.js'

describe('loadImprovementRecipes', () => {
  it('returns all six built-in recipes', () => {
    const recipes = loadImprovementRecipes()
    expect(recipes).toHaveLength(6)
  })

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
})

describe('formatRecipeCatalog', () => {
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
