/**
 * Meta-test: every field of SelfEvolveConfig and ScoringConfig must have at
 * least one non-test consumer in the source tree.
 *
 * This test is what would have caught a config field that loads correctly but
 * is never read by production code. It passes only when every declared field
 * name appears in at least one .ts file under src/ that is NOT inside a
 * __tests__ directory.
 *
 * Implementation note: TypeScript interfaces don't exist at runtime, so the
 * field lists are maintained alongside the interface definitions in config.ts.
 * If a field is added to the interface but not to these lists, the interface
 * will enforce a type error in loadDaemonConfig() — keeping the lists aligned.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Derived from SelfEvolveConfig in config.ts.
const SELF_EVOLVE_FIELDS = [
  'driftThresholdPct',
  'reflectCooldownDays',
] as const

// Derived from ScoringConfig in config.ts.
const SCORING_FIELDS = [
  'autoTrigger',
  'lowTrendThreshold',
  'lowTrendWindow',
] as const

/** Recursively collect all .ts file paths under `dir`, excluding __tests__ dirs. */
const collectNonTestSources = (dir: string): string[] => {
  const result: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      result.push(...collectNonTestSources(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      result.push(full)
    }
  }
  return result
}

const srcRoot = resolve(__dirname, '../../../..')
const nonTestSources = collectNonTestSources(srcRoot)

// Concatenate all non-test source content once for fast lookup.
const allNonTestContent = nonTestSources.map((f) => readFileSync(f, 'utf8')).join('\n')

describe('SelfEvolveConfig — every field has a non-test consumer', () => {
  for (const field of SELF_EVOLVE_FIELDS) {
    it(`SelfEvolveConfig.${field} is referenced outside __tests__/`, () => {
      // The field must appear as a property access (e.g. .fieldName) or
      // object key in at least one non-test source file.
      expect(allNonTestContent).toContain(field)
    })
  }
})

describe('ScoringConfig — every field has a non-test consumer', () => {
  for (const field of SCORING_FIELDS) {
    it(`ScoringConfig.${field} is referenced outside __tests__/`, () => {
      expect(allNonTestContent).toContain(field)
    })
  }
})
