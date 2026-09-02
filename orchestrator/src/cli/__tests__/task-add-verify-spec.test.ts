/**
 * Tests for the --verify vitest-path existence check (checkVitestPathsExist).
 *
 * The check warns at enqueue time when a literal (non-glob) path argument
 * to `vitest run` does not exist on disk. It is a warning (not a hard
 * rejection) so tasks that are about to create the file are not blocked.
 *
 * The existing absolute-path and whole-suite rejections are exercised in
 * their existing test suites; this file focuses on the new check only.
 */

import { describe, it, expect } from 'vitest'
import { checkVitestPathsExist, containsAbsoluteRepoPath, isFullSuiteVerifyCmd } from '../args'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build injected helpers that treat a fixed set of paths as existing.
 * Everything else is missing.
 */
const makeHelpers = (
  existingPaths: string[],
  repoRoot = '/repo',
) => {
  const existing = new Set(existingPaths)
  const exists = (absPath: string) => existing.has(absPath)
  const resolveDir = (relDir: string) =>
    relDir === '.' ? repoRoot : `${repoRoot}/${relDir}`
  return { exists, resolveDir }
}

// ---------------------------------------------------------------------------
// checkVitestPathsExist — core behaviour
// ---------------------------------------------------------------------------

describe('checkVitestPathsExist — non-existent literal path', () => {
  it('returns a warning when the named test file does not exist', () => {
    const { exists, resolveDir } = makeHelpers([])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/does/not/exist.test.ts",
      exists,
      resolveDir,
    )
    expect(result).not.toBeNull()
    expect(result).toContain('src/does/not/exist.test.ts')
    expect(result).toContain('[mars]')
  })

  it('names the directory context in the warning', () => {
    const { exists, resolveDir } = makeHelpers([])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/missing.test.ts",
      exists,
      resolveDir,
    )
    expect(result).toContain('orchestrator/')
  })
})

describe('checkVitestPathsExist — existing literal path', () => {
  it('returns null when the named test file exists', () => {
    const { exists, resolveDir } = makeHelpers([
      '/repo/orchestrator/src/core/queue.test.ts',
    ])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/core/queue.test.ts",
      exists,
      resolveDir,
    )
    expect(result).toBeNull()
  })

  it('returns null when no cd prefix is given and file exists at repo root', () => {
    const { exists, resolveDir } = makeHelpers(['/repo/src/foo.test.ts'])
    const result = checkVitestPathsExist(
      "npx vitest run src/foo.test.ts",
      exists,
      resolveDir,
    )
    expect(result).toBeNull()
  })
})

describe('checkVitestPathsExist — glob patterns are skipped', () => {
  it('returns null for a * glob even when nothing would match', () => {
    const { exists, resolveDir } = makeHelpers([])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/**/*.test.ts",
      exists,
      resolveDir,
    )
    expect(result).toBeNull()
  })

  it('returns null for a ? glob', () => {
    const { exists, resolveDir } = makeHelpers([])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/foo?.test.ts",
      exists,
      resolveDir,
    )
    expect(result).toBeNull()
  })

  it('returns null for a brace-expansion pattern', () => {
    const { exists, resolveDir } = makeHelpers([])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/{foo,bar}.test.ts",
      exists,
      resolveDir,
    )
    expect(result).toBeNull()
  })
})

describe('checkVitestPathsExist — warn-not-reject escape hatch', () => {
  it('returns a non-empty string (not an Error, not null) for a missing path', () => {
    const { exists, resolveDir } = makeHelpers([])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/missing.test.ts",
      exists,
      resolveDir,
    )
    // The result is a warning string, never thrown — callers decide whether
    // to print-and-continue (warn) or print-and-abort (reject).
    expect(typeof result).toBe('string')
    expect(result!.length).toBeGreaterThan(0)
  })

  it('returns null (no warning) for a command with no vitest invocation', () => {
    const { exists, resolveDir } = makeHelpers([])
    const result = checkVitestPathsExist(
      "cd orchestrator && npm run typecheck",
      exists,
      resolveDir,
    )
    expect(result).toBeNull()
  })
})

describe('checkVitestPathsExist — multiple file args', () => {
  it('warns on the first missing file when multiple are given', () => {
    const { exists, resolveDir } = makeHelpers([
      '/repo/orchestrator/src/exists.test.ts',
    ])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/exists.test.ts src/missing.test.ts",
      exists,
      resolveDir,
    )
    expect(result).not.toBeNull()
    expect(result).toContain('src/missing.test.ts')
  })

  it('returns null when all multiple literal files exist', () => {
    const { exists, resolveDir } = makeHelpers([
      '/repo/orchestrator/src/a.test.ts',
      '/repo/orchestrator/src/b.test.ts',
    ])
    const result = checkVitestPathsExist(
      "cd orchestrator && npx vitest run src/a.test.ts src/b.test.ts",
      exists,
      resolveDir,
    )
    expect(result).toBeNull()
  })
})

describe('checkVitestPathsExist — cd tracking across segments', () => {
  it('resolves paths relative to the most recent cd', () => {
    // File exists under ui/, not orchestrator/
    const { exists, resolveDir } = makeHelpers([
      '/repo/ui/src/app.test.tsx',
    ])
    const result = checkVitestPathsExist(
      "cd ui && npx vitest run src/app.test.tsx",
      exists,
      resolveDir,
    )
    expect(result).toBeNull()
  })

  it('reports missing when a later cd changes the directory away from where the file exists', () => {
    const { exists, resolveDir } = makeHelpers([
      '/repo/orchestrator/src/foo.test.ts',
    ])
    // cd switches to ui/ before the vitest call — file is not there
    const result = checkVitestPathsExist(
      "cd ui && npx vitest run src/foo.test.ts",
      exists,
      resolveDir,
    )
    expect(result).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Guard: existing rejections still pass
// ---------------------------------------------------------------------------

describe('containsAbsoluteRepoPath — existing guard unaffected', () => {
  it('returns true for an absolute repo path', () => {
    expect(containsAbsoluteRepoPath('cd /repo/orchestrator && npm test', '/repo')).toBe(true)
  })

  it('returns false for a relative path', () => {
    expect(containsAbsoluteRepoPath('cd orchestrator && npm test', '/repo')).toBe(false)
  })

  it('returns false when repoRoot is empty', () => {
    expect(containsAbsoluteRepoPath('cd /repo/orchestrator && npm test', '')).toBe(false)
  })
})

describe('isFullSuiteVerifyCmd — existing guard unaffected', () => {
  it('returns true for bare npm test', () => {
    expect(isFullSuiteVerifyCmd('npm test')).toBe(true)
  })

  it('returns true for bare npm run test', () => {
    expect(isFullSuiteVerifyCmd('npm run test')).toBe(true)
  })

  it('returns true for vitest run with no file arg', () => {
    expect(isFullSuiteVerifyCmd('cd orchestrator && npx vitest run')).toBe(true)
  })

  it('returns false for a scoped vitest run with a file arg', () => {
    expect(
      isFullSuiteVerifyCmd('cd orchestrator && npx vitest run src/core/queue.test.ts'),
    ).toBe(false)
  })
})
