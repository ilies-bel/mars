/**
 * Unit tests for the hermeticViolation() predicate in test/hermetic-repo.ts.
 *
 * These tests prove the widened guard — in particular the regression case that
 * the old guard in setup-env.ts MISSED: a MARS_REPO nested under the repo root
 * but NOT under `.mars/`.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hermeticViolation } from './hermetic-repo.js'

// Use a real tmpdir so realpathSync can resolve it on macOS (/tmp → /private/tmp).
const fakeRepoRoot = mkdtempSync(join(tmpdir(), 'hermetic-repo-test-'))

describe('hermeticViolation', () => {
  it('returns null for undefined', () => {
    expect(hermeticViolation(undefined, fakeRepoRoot)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(hermeticViolation('', fakeRepoRoot)).toBeNull()
  })

  it('returns null for a tmpdir path outside the repo root', () => {
    // A different tmpdir entry — completely outside fakeRepoRoot.
    const outside = mkdtempSync(join(tmpdir(), 'hermetic-outside-'))
    expect(hermeticViolation(outside, fakeRepoRoot)).toBeNull()
  })

  it('detects violation for <repoRoot>/.mars (the case the old guard caught)', () => {
    const dotMars = join(fakeRepoRoot, '.mars')
    const result = hermeticViolation(dotMars, fakeRepoRoot)
    expect(result).not.toBeNull()
    expect(result).toContain('[mars-test hermetic violation]')
    expect(result).toContain(dotMars)
    expect(result).toContain(fakeRepoRoot)
  })

  // ── Regression test ──────────────────────────────────────────────────────
  // This is the case the old guard MISSED: MARS_REPO was set to a bare relative
  // key (e.g. `learned-recipes-test-${pid}-${n}`) which resolves against
  // process.cwd() (= orchestrator/) to
  // `<repoRoot>/orchestrator/learned-recipes-test-<pid>-<n>`.
  // That path is NOT under `.mars/`, so the old predicate passed it through
  // silently while PGlite wrote ~688 files there.
  it('detects violation for <repoRoot>/orchestrator/learned-recipes-test-1-1 (old guard missed case)', () => {
    const leakedPath = join(fakeRepoRoot, 'orchestrator', 'learned-recipes-test-1-1')
    const result = hermeticViolation(leakedPath, fakeRepoRoot)
    expect(result).not.toBeNull()
    expect(result).toContain('[mars-test hermetic violation]')
    expect(result).toContain(leakedPath)
    expect(result).toContain(fakeRepoRoot)
  })

  it('detects violation for the repo root itself', () => {
    const result = hermeticViolation(fakeRepoRoot, fakeRepoRoot)
    expect(result).not.toBeNull()
    expect(result).toContain('[mars-test hermetic violation]')
  })

  it('error message includes mkdtempSync fix hint', () => {
    const result = hermeticViolation(join(fakeRepoRoot, 'any-path'), fakeRepoRoot)
    expect(result).toContain('mkdtempSync')
    expect(result).toContain('test/setup-env.ts')
  })
})
