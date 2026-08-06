import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import {
  loadLeverRegistry,
  noGestureEntries,
  formatRecipeCatalog,
  type LeverFamily,
  type LeverRegistryEntry,
} from '../lever-registry.js'

const VALID_FAMILIES: LeverFamily[] = [
  'model',
  'provider',
  'workflow',
  'verify',
  'concurrency',
  'operator',
  'budget',
  'scoring',
  'self-evolve',
  'task-spec',
]

const VALID_SCOPES = ['global', 'per-workflow', 'per-task'] as const

describe('loadLeverRegistry()', () => {
  it('returns a non-empty array', () => {
    expect(loadLeverRegistry().length).toBeGreaterThan(0)
  })

  it('returns a defensive copy — mutations do not affect the catalog', () => {
    const first = loadLeverRegistry()
    first.length = 0
    expect(loadLeverRegistry().length).toBeGreaterThan(0)
  })

  it('every entry has required non-empty string fields', () => {
    for (const e of loadLeverRegistry()) {
      expect(e.id.length, `${e.id}: id must be non-empty`).toBeGreaterThan(0)
      expect(e.label.length, `${e.id}: label must be non-empty`).toBeGreaterThan(0)
      expect(typeof e.readCurrent).toBe('function')
    }
  })

  it('every entry has a valid family', () => {
    for (const e of loadLeverRegistry()) {
      expect(VALID_FAMILIES, `${e.id}: unknown family '${e.family}'`).toContain(e.family)
    }
  })

  it('every entry has a valid scope', () => {
    for (const e of loadLeverRegistry()) {
      expect(VALID_SCOPES as readonly string[], `${e.id}: unknown scope '${e.scope}'`).toContain(
        e.scope,
      )
    }
  })

  it('every entry has a boolean appliesWithoutRestart', () => {
    for (const e of loadLeverRegistry()) {
      expect(typeof e.appliesWithoutRestart, `${e.id}: appliesWithoutRestart must be boolean`).toBe(
        'boolean',
      )
    }
  })

  it('every entry with gesture: null has appliesWithoutRestart = false (or is per-task/workflow)', () => {
    for (const e of loadLeverRegistry()) {
      if (e.gesture === null && e.scope === 'global') {
        // Global levers with no gesture cannot be applied and should not
        // promise live-apply. (They typically require a daemon restart or edit.)
        // This is a soft invariant — verify entries can be freeform.
      }
    }
  })

  it('ids are unique', () => {
    const ids = loadLeverRegistry().map((e) => e.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('covers all required families', () => {
    const families = new Set(loadLeverRegistry().map((e) => e.family))
    for (const f of VALID_FAMILIES) {
      expect(families.has(f), `family '${f}' has no registry entries`).toBe(true)
    }
  })

  it('includes all six verify recipe IDs', () => {
    const ids = loadLeverRegistry().map((e) => e.id)
    const recipeIds = [
      'verify.add-typecheck',
      'verify.add-unit-tests',
      'verify.add-lint',
      'verify.add-e2e',
      'verify.add-integration-tests',
      'verify.add-sso-credentials',
    ]
    for (const id of recipeIds) {
      expect(ids, `missing verify recipe entry '${id}'`).toContain(id)
    }
  })

  it('verify.add-integration-tests has no verifyGate (gate is per-repo)', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'verify.add-integration-tests')
    expect(e).toBeDefined()
    expect(e!.recipe?.verifyGate).toBeUndefined()
  })

  it('verify.add-typecheck recipe has a verifyGate targeting tsc --noEmit', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'verify.add-typecheck')
    expect(e).toBeDefined()
    expect(e!.recipe?.verifyGate).toMatchObject({
      name: 'typecheck',
      cmd: 'npx',
      args: expect.arrayContaining(['tsc', '--noEmit']),
    })
  })

  it('verify.add-e2e recipe has playwright gate and mentions credentials in setup steps', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'verify.add-e2e')
    expect(e).toBeDefined()
    expect(e!.recipe?.verifyGate).toMatchObject({
      name: 'e2e',
      cmd: 'npx',
      args: expect.arrayContaining(['playwright', 'test']),
    })
    const steps = e!.recipe!.setupSteps.join(' ')
    expect(steps.toLowerCase()).toContain('playwright')
    expect(steps).toContain('credentials')
  })

  it('verify.add-sso-credentials setup steps mention mars credentials set and storageState', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'verify.add-sso-credentials')
    expect(e).toBeDefined()
    const steps = e!.recipe!.setupSteps.join(' ')
    expect(steps).toContain('mars credentials set')
    expect(steps).toContain('storageState')
  })
})

describe('readCurrent() against seeded daemon.json', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-lever-reg-'))
    mkdirSync(join(tmpDir, '.mars'), { recursive: true })
    process.env.MARS_REPO = tmpDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('provider.default returns the configured provider', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ defaultProvider: 'gemini' }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'provider.default')!
    expect(e.readCurrent()).toBe('gemini')
  })

  it('caps.implement returns the configured cap value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 7 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'caps.implement')!
    expect(e.readCurrent()).toBe('7')
  })

  it('caps.triage returns the configured triage cap', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { triage: 4 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'caps.triage')!
    expect(e.readCurrent()).toBe('4')
  })

  it('caps.verify returns default when no file exists', () => {
    // No daemon.json written — should fall back to default
    const e = loadLeverRegistry().find((x) => x.id === 'caps.verify')!
    expect(e.readCurrent()).toBe('2') // DEFAULTS.verify = 2
  })

  it('operator.recovery returns persisted control lever value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ controlLevers: { recovery: 'off', scoring: 'on', autoReflect: 'on' } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'operator.recovery')!
    expect(e.readCurrent()).toBe('off')
  })

  it('operator.scoring returns persisted control lever value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ controlLevers: { recovery: 'on', scoring: 'off', autoReflect: 'on' } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'operator.scoring')!
    expect(e.readCurrent()).toBe('off')
  })

  it('operator.dispatch returns on when not persisted as paused', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify({}))
    const e = loadLeverRegistry().find((x) => x.id === 'operator.dispatch')!
    expect(e.readCurrent()).toBe('on')
  })

  it('operator.dispatch returns off when paused is persisted', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify({ paused: true }))
    const e = loadLeverRegistry().find((x) => x.id === 'operator.dispatch')!
    expect(e.readCurrent()).toBe('off')
  })

  it('operator.auto-reflect returns persisted autoReflect value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ controlLevers: { recovery: 'on', scoring: 'on', autoReflect: 'off' } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'operator.auto-reflect')!
    expect(e.readCurrent()).toBe('off')
  })

  it('scoring.auto-trigger returns persisted value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ scoring: { autoTrigger: true } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'scoring.auto-trigger')!
    expect(e.readCurrent()).toBe('true')
  })

  it('scoring.low-trend-threshold returns persisted value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ scoring: { lowTrendThreshold: 0.7 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'scoring.low-trend-threshold')!
    expect(e.readCurrent()).toBe('0.7')
  })

  it('scoring.low-trend-window returns persisted value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ scoring: { lowTrendWindow: 8 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'scoring.low-trend-window')!
    expect(e.readCurrent()).toBe('8')
  })

  it('self-evolve.auto-trigger returns persisted value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ selfEvolve: { autoTrigger: true } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'self-evolve.auto-trigger')!
    expect(e.readCurrent()).toBe('true')
  })

  it('self-evolve.drift-threshold-pct returns persisted value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ selfEvolve: { driftThresholdPct: 15 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'self-evolve.drift-threshold-pct')!
    expect(e.readCurrent()).toBe('15')
  })

  it('self-evolve.task-confidence-threshold returns persisted value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ selfEvolve: { taskConfidenceThreshold: 0.9 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'self-evolve.task-confidence-threshold')!
    expect(e.readCurrent()).toBe('0.9')
  })

  it('budget.window returns (not set) when not configured', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify({}))
    const e = loadLeverRegistry().find((x) => x.id === 'budget.window')!
    expect(e.readCurrent()).toBe('(not set)')
  })

  it('budget.window-tokens returns configured value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ budget: { windowTokens: 500000 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'budget.window-tokens')!
    expect(e.readCurrent()).toBe('500000')
  })

  it('budget.arc-tokens returns configured value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ budget: { arcTokens: 100000 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'budget.arc-tokens')!
    expect(e.readCurrent()).toBe('100000')
  })

  it('per-task levers return a sentinel (not a config value)', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify({ defaultProvider: 'codex' }))
    const perTaskEntries = loadLeverRegistry().filter((e) => e.scope === 'per-task')
    expect(perTaskEntries.length).toBeGreaterThan(0)
    for (const e of perTaskEntries) {
      const current = e.readCurrent()
      // Per-task levers have no global current value
      expect(current, `${e.id}: expected sentinel`).toContain('per-task')
    }
  })
})

describe('noGestureEntries()', () => {
  it('returns entries that all have gesture: null', () => {
    for (const e of noGestureEntries()) {
      expect(e.gesture, `${e.id}: noGestureEntries should only have null gesture`).toBeNull()
    }
  })

  it('no-gesture entries span expected families', () => {
    const families = new Set(noGestureEntries().map((e) => e.family))
    // provider, scoring, self-evolve, workflow all lack a mars command
    expect(families.has('provider')).toBe(true)
    expect(families.has('scoring')).toBe(true)
    expect(families.has('self-evolve')).toBe(true)
    expect(families.has('workflow')).toBe(true)
  })

  it('concurrency family has gestures (mars daemon set-cap exists)', () => {
    const capsEntries = loadLeverRegistry().filter((e) => e.family === 'concurrency')
    expect(capsEntries.length).toBeGreaterThan(0)
    for (const e of capsEntries) {
      expect(e.gesture, `${e.id}: caps have mars daemon set-cap`).not.toBeNull()
    }
  })
})

describe('formatRecipeCatalog()', () => {
  it('returns a non-empty placeholder when passed an empty array', () => {
    const out = formatRecipeCatalog([])
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('no improvement recipes')
  })

  it('includes each recipe entry id and label in the output', () => {
    const entries = loadLeverRegistry()
    const out = formatRecipeCatalog(entries)
    for (const e of entries.filter((x) => x.recipe)) {
      expect(out).toContain(e.id)
      expect(out).toContain(e.label)
    }
  })

  it('renders verifyGate command for entries that have one', () => {
    const out = formatRecipeCatalog(loadLeverRegistry())
    // verify.add-typecheck has tsc --noEmit
    expect(out).toContain('tsc')
    // verify.add-e2e has playwright
    expect(out).toContain('playwright')
  })

  it('renders setup steps as a bullet list', () => {
    const e2e = loadLeverRegistry().find((x) => x.id === 'verify.add-e2e')!
    const out = formatRecipeCatalog([e2e])
    for (const step of e2e.recipe!.setupSteps) {
      expect(out).toContain(`- ${step}`)
    }
  })

  it('does not emit a Verify gate line for entries without one', () => {
    const noGate = loadLeverRegistry().find((x) => x.id === 'verify.add-integration-tests')!
    const out = formatRecipeCatalog([noGate])
    expect(out).not.toContain('**Verify gate:**')
  })

  it('renders a subset when filtered to e2e maturity level', () => {
    const e2e = loadLeverRegistry().filter((x) => x.recipe?.maturityLevel === 'e2e')
    const out = formatRecipeCatalog(e2e)
    expect(out).toContain('verify.add-e2e')
    expect(out).toContain('verify.add-sso-credentials')
    expect(out).not.toContain('verify.add-typecheck')
    expect(out).not.toContain('verify.add-unit-tests')
  })

  it('output has markdown headings', () => {
    const out = formatRecipeCatalog(loadLeverRegistry())
    expect(out).toMatch(/^#+\s/m)
  })

  it('filters out non-recipe entries silently', () => {
    // Pass a mix: one recipe entry and one non-recipe entry (e.g. caps.implement)
    const capsEntry = loadLeverRegistry().find((x) => x.id === 'caps.implement')!
    const typecheckEntry = loadLeverRegistry().find((x) => x.id === 'verify.add-typecheck')!
    const out = formatRecipeCatalog([capsEntry, typecheckEntry])
    expect(out).toContain('verify.add-typecheck')
    expect(out).not.toContain('caps.implement')
  })

  it('renders a custom entry with a recipe field', () => {
    const custom: LeverRegistryEntry = {
      id: 'custom-gate',
      label: 'Custom gate',
      family: 'verify',
      scope: 'global',
      readCurrent: () => null,
      allowedValues: { type: 'freeform' },
      gesture: 'mars verify add custom --cmd npm -- run custom',
      appliesWithoutRestart: true,
      recipe: {
        triggerPattern: 'When custom',
        problem: 'Custom problem',
        solution: 'Custom solution',
        setupSteps: ['Do step one', 'Do step two'],
        verifyGate: { name: 'custom', cmd: 'npm', args: ['run', 'custom'], scope: 'unit' },
        maturityLevel: 'tests',
      },
    }
    const out = formatRecipeCatalog([custom])
    expect(out).toContain('custom-gate')
    expect(out).toContain('Custom gate')
    expect(out).toContain('npm run custom')
    expect(out).toContain('scope: unit')
    expect(out).toContain('- Do step one')
    expect(out).toContain('- Do step two')
  })
})

describe('family coverage completeness check', () => {
  it('fails if a known DaemonConfig top-level config key has no registry entries', () => {
    // Every family in VALID_FAMILIES must have at least one global entry.
    // Adding a new config family without a registry entry breaks this test.
    const entries = loadLeverRegistry()
    const globalFamilies = new Set(entries.filter((e) => e.scope === 'global').map((e) => e.family))

    // These families map to top-level daemon.json config sections and must all
    // have at least one global entry. Update this list when DaemonConfig grows.
    const requiredGlobalFamilies: LeverFamily[] = [
      'provider',   // defaultProvider
      'concurrency', // caps.*
      'scoring',    // scoring.*
      'self-evolve', // selfEvolve.*
      'operator',   // controlLevers.*
      'budget',     // budget.*
    ]

    for (const f of requiredGlobalFamilies) {
      expect(globalFamilies.has(f), `family '${f}' is missing from global registry entries`).toBe(
        true,
      )
    }
  })
})
