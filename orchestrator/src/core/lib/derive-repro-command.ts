import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
}

/**
 * Mirror of `resolveVerifyCwd` in `workflows/implement-workflow.ts`. The
 * verify step doesn't always run at the worktree root: if the project
 * lives in a subdirectory (e.g. `orchestrator/` in this repo), verify
 * resolves there instead. A repro command rooted at the worktree would
 * not actually reproduce the failure — it would either fail to find the
 * test runner or run a different test set. Both call sites must use the
 * same heuristic; keeping the implementation here and importing from
 * the workflow guarantees they cannot drift.
 *
 * Heuristic: a directory is a project if it has both `package.json` and
 * `tsconfig.json`. Worktree root wins; otherwise fall back to
 * `<worktreeRoot>/orchestrator`; otherwise return the worktree root
 * unchanged.
 */
export const resolveVerifyCwd = (worktreeRoot: string): string => {
  const hasProject = (dir: string): boolean =>
    existsSync(resolve(dir, 'package.json')) &&
    existsSync(resolve(dir, 'tsconfig.json'))
  if (hasProject(worktreeRoot)) return worktreeRoot
  const orchestrator = resolve(worktreeRoot, 'orchestrator')
  if (hasProject(orchestrator)) return orchestrator
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
