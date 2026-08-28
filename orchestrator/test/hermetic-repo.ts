/**
 * Hermetic-repo guard predicate (ADR-0095 widened form).
 *
 * The original guard in test/setup-env.ts checked only whether MARS_REPO
 * pointed at the live `.mars/` directory.  That was too narrow: a relative
 * key like `learned-recipes-test-${pid}-${n}` resolves against process.cwd()
 * to `<repoRoot>/orchestrator/<key>`, which is NOT under `.mars/` but still
 * writes 688+ files per test invocation inside the repo working tree.
 *
 * This module exports a single pure predicate that widens the check to the
 * repo root so ANY path inside the repo — regardless of subdirectory depth or
 * name — is caught at the moment of violation rather than discovered after the
 * fact by an external indexer.
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * Walk up to the first ancestor that exists, realpath it, then re-attach the
 * non-existent tail.  This is necessary because on macOS TMPDIR resolves
 * through the `/tmp` → `/private/tmp` symlink, so `realpathSync` on a path
 * whose parent IS the symlink-target but whose leaf does not yet exist would
 * otherwise throw and fall back to the un-resolved literal — making the
 * comparison miss the symlink and pass a path that should be blocked.
 */
function tryRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    const parent = dirname(p)
    if (parent === p) {
      // Reached the filesystem root with no hit; return literal.
      return p
    }
    return join(tryRealpath(parent), basename(p))
  }
}

/**
 * Returns `null` when `marsRepo` is acceptable, or a complete,
 * operator-readable error message when it is not.
 *
 * Rules:
 * - `undefined` or `''` → `null`.  The test manages its own isolation (the
 *   carve-out documented in setup-env.ts for context.test.ts).
 * - A path equal to or nested under `repoRoot` → violation.
 * - A path outside `repoRoot` (e.g. a `mkdtempSync(join(tmpdir(), ...))`) → `null`.
 *
 * Both sides are realpath-normalised before comparison so a symlinked TMPDIR
 * (macOS `/tmp` → `/private/tmp`) is never misjudged.
 */
export function hermeticViolation(
  marsRepo: string | undefined,
  repoRoot: string,
): string | null {
  if (marsRepo === undefined || marsRepo === '') {
    return null
  }

  const absPath = resolve(marsRepo)
  const realPath = tryRealpath(absPath)
  const realRoot = tryRealpath(repoRoot)

  if (realPath === realRoot || realPath.startsWith(realRoot + sep)) {
    return (
      `[mars-test hermetic violation] MARS_REPO="${marsRepo}" resolves to ` +
      `a path inside the repo root "${repoRoot}". ` +
      `Set MARS_REPO to a \`mkdtempSync(join(tmpdir(), ...))\` path, ` +
      `or rely on the global hermetic MARS_REPO in test/setup-env.ts.`
    )
  }

  return null
}
