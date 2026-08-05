/**
 * Parity build-guard (ADR-0058). The wizard's declarative prompt table is the
 * single source of truth for what `mars init` asks. This suite FAILS the build
 * if any prompt is not fully reachable non-interactively:
 *   - its `flag` must be a declared flag in cli/args.ts (BOOLEAN_FLAGS for
 *     boolean prompts, FLAGS_WITH_VALUES for string/enum prompts).
 *
 * It also exercises the controller with a mocked readline + injected isTTY so
 * the suite never blocks on real stdin.
 */

import { describe, expect, it } from 'vitest'
import { BOOLEAN_FLAGS, FLAGS_WITH_VALUES } from '../../cli/args'
import { WIZARD_DEFAULTS, WIZARD_PROMPTS, type WizardPrompt } from '../wizard'
import { runWizard, type LineReader } from '../wizard-controller'

describe('ADR-0058 — wizard / non-interactive parity', () => {
  it('ships the required registerProject prompt', () => {
    const ids = WIZARD_PROMPTS.map((p) => p.id)
    expect(ids).toContain('registerProject')
  })

  it('does not ship supervisor-only prompts', () => {
    const ids = WIZARD_PROMPTS.map((p) => p.id)
    expect(ids).not.toContain('supervisors')
    expect(ids).not.toContain('scaffoldMode')
  })

  it('every prompt has a non-empty flag AND configKey (no flag-less prompts)', () => {
    for (const p of WIZARD_PROMPTS) {
      expect(p.flag, `prompt ${p.id} flag`).toMatch(/^--?[a-z]/)
      expect(p.configKey, `prompt ${p.id} configKey`).not.toBe('')
    }
  })

  it("every prompt's flag is a declared flag in cli/args.ts", () => {
    const valueFlags = FLAGS_WITH_VALUES
    const boolFlags = BOOLEAN_FLAGS
    const undeclared: string[] = []
    for (const p of WIZARD_PROMPTS) {
      const inValue = valueFlags.has(p.flag)
      const inBool = boolFlags.has(p.flag)
      // boolean prompts must live in BOOLEAN_FLAGS; string/enum in FLAGS_WITH_VALUES
      const ok = p.type === 'boolean' ? inBool : inValue
      if (!ok) {
        undeclared.push(
          `${p.id}: flag ${p.flag} (type ${p.type}) not in ${
            p.type === 'boolean' ? 'BOOLEAN_FLAGS' : 'FLAGS_WITH_VALUES'
          }`,
        )
      }
    }
    expect(undeclared).toEqual([])
  })

  it('enum prompts declare their choices and default is among them', () => {
    for (const p of WIZARD_PROMPTS) {
      if (p.type !== 'enum') continue
      expect(p.choices, `prompt ${p.id} choices`).toBeTruthy()
      expect(p.choices).toContain(p.default)
    }
  })

  // A synthetic prompt with a bogus flag must be caught by the flag guard.
  it('the flag parity check would FAIL for an unwired prompt', () => {
    const bogus: WizardPrompt = {
      id: 'registerProject',
      question: 'bogus',
      flag: '--definitely-not-a-real-flag',
      configKey: 'definitelyNotARealKey',
      type: 'boolean',
      default: true,
    }
    const flagDeclared =
      FLAGS_WITH_VALUES.has(bogus.flag) || BOOLEAN_FLAGS.has(bogus.flag)
    expect(flagDeclared).toBe(false)
  })
})

describe('wizard-controller — non-interactive resolution (no stdin hang)', () => {
  // A reader that throws if ever called — proves the non-interactive paths
  // never touch stdin.
  const neverRead: LineReader = () => {
    throw new Error('readLine must not be called on the non-interactive path')
  }

  it('falls back to defaults on a non-TTY with no flags/config', async () => {
    const choices = await runWizard(WIZARD_PROMPTS, {
      isTTY: false,
      flags: {},
      force: false,
      readLine: neverRead,
    })
    expect(choices).toEqual(WIZARD_DEFAULTS)
  })

  it('honours flags over defaults (non-TTY)', async () => {
    const choices = await runWizard(WIZARD_PROMPTS, {
      isTTY: false,
      flags: {
        '--register-project': false,
      },
      force: false,
      readLine: neverRead,
    })
    expect(choices).toEqual({
      registerProject: false,
      verifyGates: [],
    })
  })

  it('honours config when no flag is present (non-TTY)', async () => {
    const choices = await runWizard(WIZARD_PROMPTS, {
      isTTY: false,
      flags: {},
      config: {
        registerProject: false,
      },
      force: false,
      readLine: neverRead,
    })
    expect(choices).toEqual({
      registerProject: false,
      verifyGates: [],
    })
  })

  it('flag beats config for the same prompt', async () => {
    const choices = await runWizard(WIZARD_PROMPTS, {
      isTTY: false,
      flags: { '--register-project': true },
      config: { registerProject: false },
      force: false,
      readLine: neverRead,
    })
    expect(choices.registerProject).toBe(true)
  })
})

describe('wizard-controller — interactive (mocked readline)', () => {
  it('reads answers via the injected reader and parses them', async () => {
    // Prompts are asked in WIZARD_PROMPTS order: registerProject.
    const queue = ['n']
    const asked: string[] = []
    const readLine: LineReader = (question) => {
      asked.push(question)
      return Promise.resolve(queue.shift() ?? '')
    }
    const choices = await runWizard(WIZARD_PROMPTS, {
      isTTY: true,
      flags: {},
      force: false,
      readLine,
    })
    expect(asked).toHaveLength(WIZARD_PROMPTS.length)
    expect(choices).toEqual({
      registerProject: false,
      verifyGates: [],
    })
  })

  it('empty interactive answers fall back to each prompt default', async () => {
    const readLine: LineReader = () => Promise.resolve('')
    const choices = await runWizard(WIZARD_PROMPTS, {
      isTTY: true,
      flags: {},
      force: false,
      readLine,
    })
    expect(choices).toEqual(WIZARD_DEFAULTS)
  })

  it('a readline error mid-stream falls through to defaults (no hang)', async () => {
    const readLine: LineReader = () =>
      Promise.reject(new Error('stdin closed'))
    const choices = await runWizard(WIZARD_PROMPTS, {
      isTTY: true,
      flags: {},
      force: false,
      readLine,
    })
    expect(choices).toEqual(WIZARD_DEFAULTS)
  })
})
