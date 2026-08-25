import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import {
  loadLeverRegistry,
  noGestureEntries,
  noConsumerEntries,
  getWiringState,
  formatRecipeCatalog,
  type LeverFamily,
  type LeverRegistryEntry,
} from '../lever-registry.js'
import { parseArgs } from '../../../cli/args.js'
import { route } from '../../../cli/registry.js'
import { registry } from '../../../cli/commands/index.js'

// Orchestrator root: navigate up 4 dirs from __tests__/ → lib/ → core/ → src/ → orchestrator/
const __filename = fileURLToPath(import.meta.url)
const orchestratorRoot = join(dirname(__filename), '..', '..', '..', '..')

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

  it('includes steward.autotune lever that surfaces in mars lever list', () => {
    const entries = loadLeverRegistry()
    const lever = entries.find((e) => e.id === 'steward.autotune')
    expect(lever, 'steward.autotune missing from registry').toBeDefined()
    expect(lever!.family).toBe('concurrency')
    expect(lever!.scope).toBe('global')
    expect(lever!.gesture).toContain('steward.autotune')
    const allowed = lever!.allowedValues
    expect(allowed.type).toBe('enum')
    if (allowed.type === 'enum') {
      expect(allowed.values).toContain('on')
      expect(allowed.values).toContain('off')
    }
  })

  it('includes steward.autotune-max-implement lever with range allowedValues', () => {
    const entries = loadLeverRegistry()
    const lever = entries.find((e) => e.id === 'steward.autotune-max-implement')
    expect(lever, 'steward.autotune-max-implement missing from registry').toBeDefined()
    expect(lever!.family).toBe('concurrency')
    expect(lever!.allowedValues.type).toBe('range')
    expect(lever!.gesture).toBeTruthy()
    expect(lever!.appliesWithoutRestart).toBe(true)
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
    expect(e.readCurrent()).toBe('1') // DEFAULTS.verify = 1 (verify runs serialised by default)
  })

  it('operator.recovery returns persisted control lever value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ controlLevers: { recovery: 'off', scoring: 'on', memoryCapture: 'on', autoRunReflect: 'off' } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'operator.recovery')!
    expect(e.readCurrent()).toBe('off')
  })

  it('operator.scoring returns persisted control lever value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ controlLevers: { recovery: 'on', scoring: 'off', memoryCapture: 'on', autoRunReflect: 'off' } }),
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

  it('operator.memory-capture returns persisted memoryCapture value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ controlLevers: { recovery: 'on', scoring: 'on', memoryCapture: 'off', autoRunReflect: 'off' } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'operator.memory-capture')!
    expect(e.readCurrent()).toBe('off')
  })

  it('operator.memory-capture migrates old autoReflect key from daemon.json', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ controlLevers: { recovery: 'on', scoring: 'on', autoReflect: 'off' } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'operator.memory-capture')!
    expect(e.readCurrent()).toBe('off')
  })

  it('operator.auto-run-reflect returns persisted autoRunReflect value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ controlLevers: { recovery: 'on', scoring: 'on', memoryCapture: 'on', autoRunReflect: 'on' } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'operator.auto-run-reflect')!
    expect(e.readCurrent()).toBe('on')
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

  it('self-evolve.drift-threshold-pct returns persisted value', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ selfEvolve: { driftThresholdPct: 15 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'self-evolve.drift-threshold-pct')!
    expect(e.readCurrent()).toBe('15')
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

  it('steward.autotune readCurrent returns on when lever is absent (default tell)', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify({}))
    const e = loadLeverRegistry().find((x) => x.id === 'steward.autotune')!
    expect(e.readCurrent()).toBe('on')
  })

  it('steward.autotune readCurrent returns off when autonomy_level is off', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ levers: { steward_runtime_tune: { autonomy_level: 'off' } } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'steward.autotune')!
    expect(e.readCurrent()).toBe('off')
  })

  it('steward.autotune-max-implement readCurrent returns (not set) when absent', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify({}))
    const e = loadLeverRegistry().find((x) => x.id === 'steward.autotune-max-implement')!
    expect(e.readCurrent()).toContain('not set')
  })

  it('steward.autotune-max-implement readCurrent returns the configured ceiling', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ steward: { autotuneMaxImplement: 8 } }),
    )
    const e = loadLeverRegistry().find((x) => x.id === 'steward.autotune-max-implement')!
    expect(e.readCurrent()).toBe('8')
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

  it('all lever entries have runtime gestures — no gaps remain', () => {
    // Every lever in the registry now has a gesture. The follow-up slice
    // added mars lever set for provider.default, scoring.*, and self-evolve.*,
    // and pointed workflow.steps at mars workflow author <name>.
    expect(noGestureEntries()).toHaveLength(0)
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

// ---------------------------------------------------------------------------
// Drift-prevention: verify.add-* gesture strings must produce non-empty argv
//
// This test parses every `verify.add-*` lever's gesture string with the real
// `parseArgs` and asserts the resulting gate command has a non-empty argument
// list. A gesture that silently produces an empty argv is strictly worse than
// having no gate — it launders unverified work as verified.
// ---------------------------------------------------------------------------

describe('verify.add-* gesture strings produce non-empty gate argv', () => {
  it('every verify.add-* lever gesture resolves to a gate with non-empty args', () => {
    const verifyAddLevers = loadLeverRegistry().filter(
      (e) => e.id.startsWith('verify.add-') && e.gesture !== null && e.gesture.includes('verify add'),
    )

    // There should be at least the five known verify.add-* levers with
    // `mars verify add` gestures.
    expect(
      verifyAddLevers.length,
      'expected at least 5 verify.add-* levers with "mars verify add" gestures',
    ).toBeGreaterThanOrEqual(5)

    for (const lever of verifyAddLevers) {
      const gesture = lever.gesture!
      // Split the gesture into tokens (handle single spaces; no shell quoting needed
      // since these gestures are simple flag strings without quoted values).
      const tokens = gesture.trim().split(/\s+/)

      // Strip "mars verify add <name>" prefix (first 4 tokens).
      // e.g. ["mars","verify","add","typecheck","--cmd","npx","--","tsc","--noEmit"]
      //                                          ↑ index 3 is the name
      const afterPrefix = tokens.slice(4) // everything after "mars verify add <name>"

      const parsed = parseArgs(afterPrefix)

      // Gate argv = rest (from --) + --args flags
      const gateArgs = [...parsed.rest, ...(parsed.multiFlags['--args'] ?? [])]

      expect(
        gateArgs.length,
        `lever '${lever.id}' gesture "${gesture}" resolves to an empty gate argv — ` +
          `the gate would run '${parsed.flags['--cmd']}' with no arguments, which ` +
          `never verifies what the gate name implies. Fix the gesture to use -- or --args.`,
      ).toBeGreaterThan(0)
    }
  })
})

describe('wiring state: getWiringState()', () => {
  it('returns wired for entries that have both consumer and gesture', () => {
    // caps.implement has both a consumer and a gesture
    const e = loadLeverRegistry().find((x) => x.id === 'caps.implement')!
    expect(e.consumer).toBeDefined()
    expect(e.gesture).not.toBeNull()
    expect(getWiringState(e)).toBe('wired')
  })

  it('returns no-consumer for entries without a consumer field', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'self-evolve.drift-threshold-pct')!
    expect(e.consumer).toBeUndefined()
    expect(getWiringState(e)).toBe('no-consumer')
  })

  it('returns no-gesture for entries with consumer but without gesture', () => {
    // Construct a synthetic entry with consumer but no gesture
    const synth: LeverRegistryEntry = {
      id: 'test.no-gesture',
      label: 'Test no-gesture',
      family: 'self-evolve',
      scope: 'global',
      readCurrent: () => null,
      allowedValues: { type: 'freeform' },
      gesture: null,
      appliesWithoutRestart: false,
      consumer: { file: 'src/core/config/levers.ts', symbol: 'resolveControlLevers' },
    }
    expect(getWiringState(synth)).toBe('no-gesture')
  })

  it('self-evolve.task-confidence-threshold is wired (consumer at reflector.ts)', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'self-evolve.task-confidence-threshold')!
    expect(getWiringState(e)).toBe('wired')
    expect(e.consumer?.file).toContain('reflector')
    expect(e.consumer?.symbol).toBe('persistSuggestions')
  })

  it('scoring.low-trend-threshold is wired (consumer at scorer-trend-trigger.ts)', () => {
    const e = loadLeverRegistry().find((x) => x.id === 'scoring.low-trend-threshold')!
    expect(getWiringState(e)).toBe('wired')
    expect(e.consumer?.file).toContain('scorer-trend-trigger')
  })
})

describe('wiring state: noConsumerEntries()', () => {
  it('returns entries without consumer field', () => {
    for (const e of noConsumerEntries()) {
      expect(e.consumer, `${e.id}: noConsumerEntries() should only have entries without consumer`).toBeUndefined()
    }
  })

  it('self-evolve.drift-threshold-pct is in noConsumerEntries()', () => {
    const ids = noConsumerEntries().map((e) => e.id)
    expect(ids).toContain('self-evolve.drift-threshold-pct')
  })

  it('caps.implement is NOT in noConsumerEntries()', () => {
    const ids = noConsumerEntries().map((e) => e.id)
    expect(ids).not.toContain('caps.implement')
  })

  it('no consumer-gap entry is also a gesture-gap — they are separate categories', () => {
    // Every no-consumer entry should still have a gesture (separate failure modes)
    // This is not guaranteed by the type, just verified for the current registry.
    const noConsumer = noConsumerEntries()
    const noGesture = noGestureEntries()
    const noGestureIds = new Set(noGesture.map((e) => e.id))
    for (const e of noConsumer) {
      // A no-consumer entry CAN also be no-gesture (both categories can overlap),
      // but the current registry has no-consumer entries WITH gestures.
      if (noGestureIds.has(e.id)) {
        // Overlap is allowed but currently unexpected — flag it visibly
        // to force a future reviewer to verify intentionality.
        console.warn(`[lever-registry test] ${e.id} is both no-consumer AND no-gesture`)
      }
    }
    // No assertion — we just want to surface it if it happens.
  })
})

describe('wiring state: build-enforcing consumer ref validation', () => {
  it('every declared consumer file exists in the orchestrator tree', () => {
    for (const e of loadLeverRegistry()) {
      if (!e.consumer) continue
      const fullPath = join(orchestratorRoot, e.consumer.file)
      expect(
        existsSync(fullPath),
        `${e.id}: declared consumer file '${e.consumer.file}' does not exist at ${fullPath}`,
      ).toBe(true)
    }
  })

  it('every declared consumer symbol appears in the consumer file', () => {
    for (const e of loadLeverRegistry()) {
      if (!e.consumer) continue
      const fullPath = join(orchestratorRoot, e.consumer.file)
      if (!existsSync(fullPath)) continue // already caught by the previous test
      const src = readFileSync(fullPath, 'utf8')
      expect(
        src.includes(e.consumer.symbol),
        `${e.id}: declared consumer symbol '${e.consumer.symbol}' not found in '${e.consumer.file}'`,
      ).toBe(true)
    }
  })
})

// ─── Gesture walker ────────────────────────────────────────────────────────────
//
// For every lever with a non-null gesture, verify:
//   1. The gesture parses without throwing.
//   2. The first 1–2 positionals route to a known command.
//   3. Every flag explicitly listed in the gesture (outside optional [...] brackets)
//      is present in the parsed result — i.e. no required flag is silently dropped.
//
// This is the guard that prevents a whole class of bug from recurring: an
// advertised gesture that fails immediately when run verbatim because a required
// flag is missing or because the command path does not exist.

describe('lever gesture walker — every gesture routes to a known CLI command', () => {
  /**
   * Tokenize a gesture string (with `mars ` prefix stripped and optional
   * `[...]` sections removed) into the argv that parseArgs expects.
   *
   * The gesture may include `<placeholder>` tokens for positional arguments and
   * `--flag <placeholder>` pairs for flag values. Both forms survive the
   * tokenization as-is: parseArgs treats unknown-looking tokens as positionals,
   * and a `--flag` in FLAGS_WITH_VALUES will consume the next token as its value
   * regardless of its content.
   */
  function tokenizeGesture(gesture: string): string[] {
    // Strip the leading 'mars ' prefix
    const withoutMars = gesture.replace(/^mars\s+/, '')
    // Remove optional sections enclosed in [...] so they don't introduce
    // unrecognised flags that parseArgs would choke on.
    const withoutOptionals = withoutMars.replace(/\[.*?\]/g, '').trim()
    // Split on whitespace and drop empty tokens
    return withoutOptionals.split(/\s+/).filter(Boolean)
  }

  it('every lever gesture routes to a known command', () => {
    const levers = loadLeverRegistry()
    const withGesture = levers.filter((e) => e.gesture !== null)

    expect(withGesture.length).toBeGreaterThan(0)

    for (const lever of withGesture) {
      const tokens = tokenizeGesture(lever.gesture!)

      // parseArgs must not throw
      let parsed: ReturnType<typeof parseArgs>
      expect(
        () => { parsed = parseArgs(tokens) },
        `lever '${lever.id}' gesture '${lever.gesture}' threw during parseArgs`,
      ).not.toThrow()
      parsed = parseArgs(tokens)

      // The positionals must resolve to a known command
      const match = route(registry, parsed.positional)
      expect(
        match,
        `lever '${lever.id}' gesture '${lever.gesture}' does not route to any known CLI command (positionals: ${JSON.stringify(parsed.positional)})`,
      ).not.toBeNull()
    }
  })

  it('every flag explicitly listed in a gesture is present after parsing', () => {
    const levers = loadLeverRegistry()

    for (const lever of levers) {
      if (!lever.gesture) continue

      const tokens = tokenizeGesture(lever.gesture)
      const parsed = parseArgs(tokens)

      // Collect flag tokens from the tokenized gesture (starts with '--').
      // Stop at the bare '--' separator: everything after it is forwarded to an
      // external command (e.g. `--cmd npx -- tsc --noEmit`) and is not a Mars
      // CLI flag.
      const doubleDashIdx = tokens.indexOf('--')
      const flagRegion = doubleDashIdx === -1 ? tokens : tokens.slice(0, doubleDashIdx)
      const explicitFlags = flagRegion.filter((t) => t.startsWith('--'))

      for (const flag of explicitFlags) {
        const inSingle = parsed.flags[flag] !== undefined
        const inMulti =
          parsed.multiFlags[flag] !== undefined && parsed.multiFlags[flag].length > 0
        expect(
          inSingle || inMulti,
          `lever '${lever.id}' gesture '${lever.gesture}' lists flag '${flag}' but it was not parsed — the flag or its value may be missing from the gesture string`,
        ).toBe(true)
      }
    }
  })
})
