import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Derive a deterministic command that reproduces a verify failure from a
 * known worktree. The orchestrator already knows the failing step and the
 * worktree path; the recovery / investigator agent should not have to
 * guess.
 *
 * Returns null when the failing step is not one of the supported verify
 * steps. The caller decides whether to include a `## Reproduce` section.
 */
export const deriveReproCommand = (
  failingStep: string,
  worktreePath: string | null,
): string | null => {
  if (!worktreePath) return null

  if (failingStep === 'verify:typecheck') {
    return `cd ${worktreePath} && npx tsc -p .`
  }

  if (failingStep === 'verify:test') {
    const testScript = pickTestScriptCommand(worktreePath)
    if (testScript) {
      return `cd ${worktreePath} && ${testScript}`
    }
    return `cd ${worktreePath} && npx vitest run`
  }

  return null
}

/**
 * Read the worktree's package.json and return a `<pm> test` invocation if
 * a `test` script is declared. Resilient to a missing or malformed
 * package.json — returns null so the caller falls back to the vitest
 * default.
 */
const pickTestScriptCommand = (worktreePath: string): string | null => {
  let raw: string
  try {
    raw = readFileSync(resolve(worktreePath, 'package.json'), 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('scripts' in parsed)
  ) {
    return null
  }
  const scripts = (parsed as { scripts?: unknown }).scripts
  if (
    typeof scripts !== 'object' ||
    scripts === null ||
    !('test' in scripts)
  ) {
    return null
  }
  const testScript = (scripts as { test?: unknown }).test
  if (typeof testScript !== 'string' || testScript.length === 0) {
    return null
  }

  return `${pickPackageManager(worktreePath)} test`
}

/**
 * Pick the package manager based on which lockfile is present in the
 * worktree. Defaults to `npm`.
 */
const pickPackageManager = (worktreePath: string): string => {
  const candidates: ReadonlyArray<{ file: string; cmd: string }> = [
    { file: 'pnpm-lock.yaml', cmd: 'pnpm' },
    { file: 'yarn.lock', cmd: 'yarn' },
    { file: 'bun.lockb', cmd: 'bun' },
    { file: 'bun.lock', cmd: 'bun' },
    { file: 'package-lock.json', cmd: 'npm' },
  ]
  for (const c of candidates) {
    try {
      readFileSync(resolve(worktreePath, c.file))
      return c.cmd
    } catch {
      // lockfile not present; try the next candidate
    }
  }
  return 'npm'
}
