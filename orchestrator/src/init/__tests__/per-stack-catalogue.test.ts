import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CATALOGUE_ENTRIES,
  GENERIC_BASELINE_KEY,
  catalogueDirectory,
  generateCatalogueEntries,
  loadCatalogue,
  lookupCatalogue,
} from '../per-stack-catalogue'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const repoOrchestratorRoot = resolve(moduleDir, '..', '..', '..')
const regenScript = resolve(
  repoOrchestratorRoot,
  'scripts',
  'regen-per-stack-catalogue.ts',
)

describe('per-stack catalogue', () => {
  it('loads from disk and exposes lookup by supervisor name', () => {
    const catalogue = loadCatalogue()
    expect(catalogue.has(GENERIC_BASELINE_KEY)).toBe(true)
    const hit = lookupCatalogue(catalogue, 'react-supervisor')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit).toContain('react-supervisor')
  })

  it('returns the generic baseline for unknown supervisor keys', () => {
    const catalogue = loadCatalogue()
    const baseline = catalogue.get(GENERIC_BASELINE_KEY)
    expect(baseline).toBeDefined()
    expect(lookupCatalogue(catalogue, 'no-such-supervisor-xyz')).toBe(baseline)
  })

  it('ships one committed file per declared catalogue entry', () => {
    const dir = catalogueDirectory()
    const present = new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -'.md'.length)),
    )
    for (const name of CATALOGUE_ENTRIES) {
      expect(present.has(name)).toBe(true)
    }
  })

  it('generates byte-identical entries on repeated invocations', () => {
    const a = generateCatalogueEntries()
    const b = generateCatalogueEntries()
    expect([...a.keys()]).toEqual([...b.keys()])
    for (const key of a.keys()) {
      expect(b.get(key)).toBe(a.get(key))
    }
  })

  it('regeneration script is deterministic across runs (byte-identical output)', () => {
    // Capture current on-disk bytes, re-run the script, compare.
    const dir = catalogueDirectory()
    const before = snapshotDir(dir)
    execFileSync('npx', ['tsx', regenScript], {
      cwd: repoOrchestratorRoot,
      stdio: 'pipe',
    })
    const after = snapshotDir(dir)
    expect(after).toEqual(before)
  })
})

const snapshotDir = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir).sort()) {
    const full = resolve(dir, entry)
    if (!statSync(full).isFile()) continue
    out[entry] = readFileSync(full, 'utf8')
  }
  return out
}
