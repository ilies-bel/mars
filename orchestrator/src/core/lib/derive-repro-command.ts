import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Walk up from `worktreeRoot` looking for `.mars/supervisors/manifest.json`
 * and return the parsed list of supervisor entries.
 *
 * The manifest lives at `<repoRoot>/.mars/supervisors/manifest.json`. For a
 * Mars worktree at `<repoRoot>/.mars/worktrees/<id>/` we must walk up three
 * levels to reach the repo root; for tests, the manifest is placed directly
 * under `<worktreeRoot>/.mars/supervisors/manifest.json` (level 0). Walking
 * up at most 6 directories covers both layouts without scanning the entire
 * filesystem.
 *
 * Returns an empty array when the manifest is absent, unreadable, or
 * malformed — callers treat an empty result as "no override available".
 */
export const readSupervisorsManifest = (
  worktreeRoot: string,
): Array<{ scope: string; verifyCwd?: string }> => {
  let manifestPath: string | null = null
  let dir = worktreeRoot
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.mars', 'supervisors', 'manifest.json')
    if (existsSync(candidate)) {
      manifestPath = candidate
      break
    }
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  if (manifestPath === null) return []

  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('supervisors' in parsed) ||
    !Array.isArray((parsed as { supervisors: unknown }).supervisors)
  ) {
    return []
  }
  const result: Array<{ scope: string; verifyCwd?: string }> = []
  for (const s of (parsed as { supervisors: unknown[] }).supervisors) {
    if (
      typeof s === 'object' &&
      s !== null &&
      'scope' in s &&
      typeof (s as { scope: unknown }).scope === 'string'
    ) {
      const entry: { scope: string; verifyCwd?: string } = {
        scope: (s as { scope: string }).scope,
      }
      if (
        'verifyCwd' in s &&
        typeof (s as { verifyCwd: unknown }).verifyCwd === 'string'
      ) {
        entry.verifyCwd = (s as { verifyCwd: string }).verifyCwd
      }
      result.push(entry)
    }
  }
  return result
}

/**
 * A verify step that actually ran during the verify phase, carrying enough
 * information to build a precise reproduce command without guessing the
 * toolchain from the step name.
 */
export interface RanVerifyStep {
  name: string
  cmd: string
  args: readonly string[]
  /** Absolute directory the step ran in. */
  stepDir: string
  passed: boolean
  /**
   * Raw exit code from the subprocess. `null` when the abort signal killed
   * the process before it could exit normally. Mirrors `VerifyStep.exitCode`.
   * Consumer slices use this to record the faithful exit code in verifyOutput
   * and in recovery prompts so fixers know the exact failure signal.
   */
  exitCode: number | null
}

/**
 * Mirror of `resolveVerifyCwd` in `workflows/implement-workflow.ts`. The
 * verify step doesn't always run at the worktree root: if the project
 * lives in a subdirectory, verify resolves there instead. A repro command
 * rooted at the worktree would not actually reproduce the failure — it would
 * either fail to find the test runner or run a different test set. Both call
 * sites must use the same heuristic; keeping the implementation here and
 * importing from the workflow guarantees they cannot drift.
 *
 * Resolution order:
 *
 * 1. Config from the supervisors manifest (`.mars/supervisors/manifest.json`)
 *    — the primary, authoritative source for a repo's layout. Activated when
 *    exactly one non-root `verifyCwd` value appears across all supervisor
 *    entries; multiple distinct values are ambiguous and fall through.
 * 2. TS-specific heuristic: a directory is a project if it has both
 *    `package.json` AND `tsconfig.json`. Worktree root wins; otherwise a
 *    generic scan of immediate subdirectories is performed — if exactly one
 *    qualifies, it is used. No specific subdirectory name is hardcoded.
 * 3. Worktree root unchanged (safe default for single-project repos
 *    whose verify commands run from the repo root).
 */
export const resolveVerifyCwd = (worktreeRoot: string): string => {
  // 1. Supervisors manifest — primary source of truth for the repo's layout.
  const entries = readSupervisorsManifest(worktreeRoot)
  const cwds = new Set(
    entries
      .map((e) => e.verifyCwd ?? e.scope)
      .filter((v) => v !== '.' && v !== ''),
  )
  if (cwds.size === 1) return resolve(worktreeRoot, [...cwds][0])

  // 2. TS-specific heuristic: root wins when it is itself a TS project;
  //    otherwise scan immediate subdirectories generically — no specific
  //    directory name (e.g. 'orchestrator') is hardcoded here.
  const hasProject = (dir: string): boolean =>
    existsSync(resolve(dir, 'package.json')) &&
    existsSync(resolve(dir, 'tsconfig.json'))
  if (hasProject(worktreeRoot)) return worktreeRoot

  try {
    const subDirs: string[] = []
    for (const entry of readdirSync(worktreeRoot)) {
      const sub = resolve(worktreeRoot, entry)
      try {
        if (lstatSync(sub).isDirectory() && hasProject(sub)) subDirs.push(sub)
      } catch {
        // Unreadable entry — skip.
      }
    }
    if (subDirs.length === 1) return subDirs[0]
  } catch {
    // worktreeRoot is unreadable — fall through to default.
  }

  // 3. Default.
  return worktreeRoot
}

/**
 * Build a reproduce hint from the full set of verify steps that actually ran.
 * Lists every step in order with its exact command and working directory,
 * annotating passing steps as `(passed)` and failing steps as `(FAILED)`.
 *
 * Unlike {@link deriveReproCommand}, this function uses only the declared
 * commands — there are no hardcoded JavaScript assumptions. A Python repo
 * running `pytest`, a Rust repo running `cargo test`, or a full-stack task
 * spanning multiple directories all produce accurate reproduce lines.
 *
 * Returns null when the steps array is empty so callers can decide whether
 * to include a reproduce section.
 */
export const buildVerifyReproHint = (
  ranSteps: readonly RanVerifyStep[],
): string | null => {
  if (ranSteps.length === 0) return null
  return ranSteps
    .map((step) => {
      const cmdLine = [step.cmd, ...step.args].join(' ')
      const status = step.passed ? 'passed' : 'FAILED'
      return `cd ${step.stepDir} && ${cmdLine}  # ${step.name} (${status})`
    })
    .join('\n')
}

/**
 * Derive a deterministic command that reproduces a verify failure from a
 * known worktree. The orchestrator already knows the failing step and the
 * worktree path; the recovery / investigator agent should not have to
 * guess.
 *
 * The emitted `cd` target is resolved via {@link resolveVerifyCwd} so the
 * command points at the same directory verify ran in — not always the
 * worktree root.
 *
 * Returns null when the failing step is not one of the supported verify
 * steps. The caller decides whether to include a `## Reproduce` section.
 */
export const deriveReproCommand = (
  failingStep: string,
  worktreePath: string | null,
): string | null => {
  if (!worktreePath) return null

  const cwd = resolveVerifyCwd(worktreePath)

  if (failingStep === 'verify:typecheck') {
    return `cd ${cwd} && npx tsc -p .`
  }

  if (failingStep === 'verify:test') {
    const testScript = pickTestScriptCommand(cwd)
    if (testScript) {
      return `cd ${cwd} && ${testScript}`
    }
    // No package.json or no `test` script — cannot infer the test command for
    // non-JS repos (Gradle, Cargo, pytest …). Return null so the caller omits
    // the reproduce section rather than emitting a wrong npx/vitest hint.
    // Callers that have `ranVerifySteps` already use buildVerifyReproHint, which
    // is language-agnostic; this path is the fallback for older task records.
    return null
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
