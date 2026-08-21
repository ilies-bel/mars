/**
 * CI-style drift check for `docs/reference/configuration.md`, mirroring the
 * `template-sync-check` pattern used for the bundled `.claude/` templates
 * (`.github/workflows/template-sync-check.yml`): regenerate the artifact
 * from its source of truth and fail if the committed copy disagrees.
 *
 * Here the source of truth is the `ENV_KNOBS` registry
 * (`../env-registry.ts`); the generation logic lives in `../reference.ts`
 * and is shared verbatim with `scripts/gen-config-reference.mjs` (the
 * `npm run docs:config` entry point), so a passing test guarantees running
 * that script would be a no-op.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ENV_KNOBS, type EnvKnob } from '../env-registry'
import { buildConfigReferenceMarkdown, MissingKnobDescriptionError } from '../reference'

const CONFIG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
// orchestrator/src/core/config -> repo root is four levels up.
const REFERENCE_PATH = resolve(CONFIG_DIR, '../../../../docs/reference/configuration.md')

describe('docs/reference/configuration.md', () => {
  it('is not committed without a knob description', () => {
    for (const knob of ENV_KNOBS) {
      expect(knob.description, `${knob.name} is missing a description`).toBeTypeOf('string')
      expect(knob.description.trim().length, `${knob.name} has a blank description`).toBeGreaterThan(0)
    }
  })

  it('matches what regenerating from ENV_KNOBS produces', () => {
    const expected = buildConfigReferenceMarkdown(ENV_KNOBS)
    const committed = readFileSync(REFERENCE_PATH, 'utf8')
    expect(committed).toBe(expected)
  })

  it('every knob appears with its name, path, type, default, and description', () => {
    const committed = readFileSync(REFERENCE_PATH, 'utf8')
    for (const knob of ENV_KNOBS) {
      expect(committed).toContain(`\`${knob.name}\``)
      expect(committed).toContain(`\`${knob.path}\``)
      expect(committed).toContain(knob.description)
    }
  })

  it('fails generation when a knob has no description', () => {
    const knobWithoutDescription = { ...ENV_KNOBS[0], description: '' } as EnvKnob
    expect(() => buildConfigReferenceMarkdown([knobWithoutDescription])).toThrow(
      MissingKnobDescriptionError,
    )
  })

  it('fails generation when a knob description is missing entirely', () => {
    const { description: _description, ...rest } = ENV_KNOBS[0] as EnvKnob
    const knobWithoutDescription = rest as EnvKnob
    expect(() => buildConfigReferenceMarkdown([knobWithoutDescription])).toThrow(
      MissingKnobDescriptionError,
    )
  })
})
