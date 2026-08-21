/**
 * Tests for `loadConfig()` and the `ENV_KNOBS` registry it composes.
 *
 * Hermetic by construction: `loadConfig()` accepts `env`/`fileConfig`
 * options instead of always reading `process.env`/the filesystem, so these
 * tests never touch the live `.mars/daemon.json` and need no
 * setup/teardown dance.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER, DEFAULTS } from '../../daemon/config'
import { ENV_KNOBS } from '../env-registry'
import { InvalidEnvValueError, loadConfig } from '../load'

const CONFIG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

describe('loadConfig', () => {
  it('falls back to built-in defaults when neither daemon.json nor env supply a value', () => {
    const config = loadConfig({ env: {}, fileConfig: {} })
    expect(config.caps.implement).toBe(DEFAULTS.implement)
    expect(config.defaultProvider).toBe(DEFAULT_PROVIDER)
  })

  it('daemon.json overrides the built-in default', () => {
    const config = loadConfig({ env: {}, fileConfig: { caps: { implement: 7 } } })
    expect(config.caps.implement).toBe(7)
  })

  it('an env var overrides the daemon.json value', () => {
    const config = loadConfig({
      env: { MARS_MAX_IMPLEMENT: '20' },
      fileConfig: { caps: { implement: 7 } },
    })
    expect(config.caps.implement).toBe(20)
  })

  it('an env var overrides the built-in default when daemon.json is silent on that field', () => {
    const config = loadConfig({ env: { MARS_MAX_TRIAGE: '3' }, fileConfig: {} })
    expect(config.caps.triage).toBe(3)
  })

  it('a bad env value fails with a named error instead of silently falling back', () => {
    expect(() => loadConfig({ env: { MARS_MAX_IMPLEMENT: 'banana' }, fileConfig: {} })).toThrow(
      InvalidEnvValueError,
    )
  })

  it('names the offending var and value in the thrown error', () => {
    try {
      loadConfig({ env: { MARS_SELF_EVOLVE_TASK_CONFIDENCE_THRESHOLD: '3' }, fileConfig: {} })
      expect.unreachable('expected loadConfig to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEnvValueError)
      const invalidErr = err as InvalidEnvValueError
      expect(invalidErr.varName).toBe('MARS_SELF_EVOLVE_TASK_CONFIDENCE_THRESHOLD')
      expect(invalidErr.rawValue).toBe('3')
    }
  })

  it('an empty-string env value is treated as absent, not invalid', () => {
    const config = loadConfig({
      env: { MARS_MAX_IMPLEMENT: '' },
      fileConfig: { caps: { implement: 9 } },
    })
    expect(config.caps.implement).toBe(9)
  })

  it('returns a deeply frozen object', () => {
    const config = loadConfig({ env: {}, fileConfig: {} })
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.caps)).toBe(true)
    expect(() => {
      config.caps.implement = 999
    }).toThrow(TypeError)
  })

  it('accepts the legacy caps.setup-install file alias', () => {
    const config = loadConfig({ env: {}, fileConfig: { caps: { 'setup-install': 4 } } })
    expect(config.caps.setupInstall).toBe(4)
  })
})

describe('ENV_KNOBS registry completeness', () => {
  const declaredNames = new Set(ENV_KNOBS.map((k) => k.name))

  // Scoped to the files this config loader owns (env-registry.ts + load.ts),
  // not the whole `src/core/config/` directory: that directory also holds
  // the unrelated Port registry (`registry.ts`, ADR-0097), which declares
  // its own `MARS_*` *selector* env vars (MARS_VERIFIER_KIND, …) under a
  // different contract entirely — a Port selector picks one of a fixed set
  // of implementation kinds, it is not a typed `MarsConfig` value override,
  // so it does not belong in this registry.
  const OWNED_FILES = ['env-registry.ts', 'load.ts']

  it('lists every MARS_* reference in the files this loader owns and finds each declared', () => {
    const found = new Set<string>()
    for (const file of OWNED_FILES) {
      const contents = readFileSync(join(CONFIG_DIR, file), 'utf8')
      for (const match of contents.matchAll(/MARS_[A-Z0-9_]+/g)) {
        found.add(match[0])
      }
    }

    expect(found.size).toBeGreaterThan(0)
    for (const name of found) {
      expect(declaredNames.has(name)).toBe(true)
    }
  })

  it('confirms the owned files are still present in src/core/config (guards against a silent rename)', () => {
    const entries = new Set(readdirSync(CONFIG_DIR))
    for (const file of OWNED_FILES) {
      expect(entries.has(file)).toBe(true)
    }
  })
})
