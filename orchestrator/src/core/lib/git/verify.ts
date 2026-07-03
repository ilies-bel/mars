import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  exec,
  execProbe,
  resolveGitBin,
  type TraceCtx,
} from './internal'
import { parseCompletionReport } from '../../../workflows/primitives/shared'

/**
 * The output marker emitted by the npm decoy `tsc` placeholder when
 * `npx tsc` is invoked without TypeScript properly installed. When this
 * string appears in a failing typecheck step's output, the step should be
 * treated as a skip rather than a real typecheck failure.
 */
export const TSC_DECOY_MARKER = 'This is not the tsc command you are looking for'

/**
 * Patterns in verify-step output that indicate an infrastructure failure
 * (embedded-PostgreSQL shutdown, Spring context initialisation error, or
 * connection-refused to an embedded port) rather than a genuine code-level
 * assertion failure.
 *
 * Background: when multiple tasks run their verify steps in parallel, each
 * gradle/Spring build spins up its own embedded-PG instance.  One build's
 * Gradle daemon teardown (or an OS-level OOM eviction) can shut down another
 * build's database mid-suite, producing the "the database system is shutting
 * down" FATAL that cascades into dozens of phantom integration-test failures
 * and empty Spring-context init errors.  These are infrastructure flakes, not
 * code regressions.
 *
 * A verify step whose output matches any of these patterns is eligible for a
 * single retry by the verify primitive (see `primitives/index.ts`).  Genuine
 * assertion failures (JUnit `AssertionFailedError`, TypeScript type errors,
 * `NullPointerException`, …) do NOT match these patterns and are never
 * silently swallowed.
 *
 * Note: empty output is intentionally NOT treated as an infra failure here.
 * An empty failure is ambiguous — it could be a Spring context init error
 * caused by an infra race, but it could also be a genuine process crash or
 * timeout.  If the empty-output case proves prevalent in practice it can be
 * added as a separate heuristic.
 */
export const VERIFY_INFRA_FAILURE_PATTERNS: readonly RegExp[] = [
  /FATAL: the database system is shutting down/i,
  /the database system is shutting down/i,
  /org\.springframework\.dao\.DataAccessResourceFailureException/,
  /org\.springframework\.context\.ApplicationContextException/,
  /Connection refused.*\d+/i,
]

/**
 * Returns `true` when the given verify-step output matches at least one
 * infrastructure-failure pattern (embedded-PG shutdown or Spring context init
 * error) rather than a genuine assertion failure.  Used by the verify
 * primitive to decide whether to retry once before counting the failure as a
 * real task failure.
 *
 * Empty or whitespace-only output returns `false` — treat it as ambiguous and
 * fall through to standard failure handling.
 */
export const isInfraFailureOutput = (output: string): boolean => {
  if (!output || output.trim() === '') return false
  return VERIFY_INFRA_FAILURE_PATTERNS.some((p) => p.test(output))
}

// True when the step is an `npx tsc …` invocation. Used in two places
// inside verifyChanges: the pre-flight presence guard and the post-flight
// decoy-output guard.
const isNpxTscStep = (spec: VerifyStepSpec): boolean =>
  spec.cmd === 'npx' && spec.args.length > 0 && spec.args[0] === 'tsc'

export interface VerifyStep {
  name: string
  passed: boolean
  output: string
  /**
   * The command that was run. Populated by {@link verifyChanges} so callers
   * can build accurate reproduce hints from `r.steps` without re-correlating
   * them against the original step specs.
   */
  cmd?: string
  args?: readonly string[]
  /** Absolute directory the step ran in. */
  stepDir?: string
  /**
   * The gate tier: 'task' means the step ran in the per-task verify phase;
   * 'integration' means the step was deferred to the integration boundary
   * and was NOT run. Absent on the `has-diff` built-in gate.
   */
  tier?: 'task' | 'integration'
  /**
   * Wall-clock milliseconds from step start to finish. Absent for deferred
   * integration-tier steps and for the built-in `has-diff` gate.
   */
  duration?: number
}

export interface VerifyStepSpec {
  name: string
  cmd: string
  args: readonly string[]
  required: boolean
  /**
   * The verify scope directory this step belongs to, relative to the
   * verify root passed to {@link verifyChanges} as `cwd`. `'.'` (or
   * omitted) is the repo-root scope and runs in the verify root itself;
   * a narrower scope (e.g. `'apps/web'`) runs in that subdirectory.
   */
  dir?: string
  /**
   * 'task': cheap gate (typecheck, lint, diff-affected tests). Runs during
   * the per-task verify phase. Default when absent.
   * 'integration': expensive gate (full test suite). Parsed and validated
   * but NOT run during the per-task verify phase; recorded as deferred with
   * a trace note "deferred to integration".
   */
  tier?: 'task' | 'integration'
}

/**
 * One verify scope from the recipe: a repo subtree and the steps that
 * apply to it. `scope` is normalised — `'.'` is the repo-root scope
 * (the always-on floor); anything else is a path relative to the repo
 * root, slash-separated, no leading `./` and no trailing `/`.
 */
export interface VerifyScope {
  scope: string
  steps: VerifyStepSpec[]
}

export interface VerifyArgs {
  cwd: string
  steps: ReadonlyArray<VerifyStepSpec>
  branch?: string
  integrationBranch?: string
  // No skip option: the diff / commits-ahead gate runs for every dispatched
  // task (ADR 0019). It fails only the genuine no-work case — a branch that has
  // diverged from integration without landing a commit on it. A branch whose
  // tip equals integration (legitimate no-op, e.g. the main-committer finding
  // the tree already clean) or is an ancestor of integration (work already
  // merged) passes: the integration branch is clean and nothing is un-merged.
  /** Optional trace context. When supplied, each verify step's shell-out
   *  emits a `tool_invoked` event under `phase: 'verify'`. Steps are probes
   *  whose non-zero exit IS the failure signal — passed through with
   *  `expectsFailure: true` so the trace severity is info instead of
   *  flagging every failing verify run as warn. */
  traceCtx?: TraceCtx
}

const runVerifyStep = async (
  name: string,
  cmd: string,
  args: readonly string[],
  cwd: string,
  traceCtx?: TraceCtx,
): Promise<VerifyStep> => {
  const verifyCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'verify' }
    : undefined
  const r = await execProbe(cmd, [...args], { cwd }, verifyCtx)
  if (r.exitCode === 0) {
    return {
      name,
      passed: true,
      output: r.stdout + r.stderr,
      cmd,
      args,
      stepDir: cwd,
    }
  }
  return {
    name,
    passed: false,
    output: r.stdout + r.stderr,
    cmd,
    args,
    stepDir: cwd,
  }
}

// Best-effort capture of the worktree state at the moment has-diff failed.
// Surfaced in the failure output so post-mortems and actionQueue investigators
// can tell apart "agent really did nothing" from "agent's commit landed
// after verify ran" (the runClaudeCode timeout-leak class) without having
// to re-shell into the worktree manually.
const captureHasDiffDiagnostics = async (
  cwd: string,
  branch: string,
  integrationBranch: string,
  traceCtx?: TraceCtx,
): Promise<string> => {
  const probe = async (
    label: string,
    args: readonly string[],
  ): Promise<string> => {
    try {
      const r = await execProbe(resolveGitBin(), [...args], { cwd }, traceCtx)
      if (r.exitCode !== 0) {
        return `${label}: <error: ${(r.stderr || 'unknown').trim()}>`
      }
      const trimmed = r.stdout.trim()
      return `${label}: ${trimmed.length > 0 ? trimmed : '(empty)'}`
    } catch (error: unknown) {
      const e = error as { stderr?: string; message?: string }
      return `${label}: <error: ${(e.stderr ?? e.message ?? 'unknown').trim()}>`
    }
  }
  const lines = await Promise.all([
    probe(`HEAD`, ['rev-parse', 'HEAD']),
    probe(`${branch}`, ['rev-parse', '--verify', `${branch}^{commit}`]),
    probe(`${integrationBranch}`, [
      'rev-parse',
      '--verify',
      `${integrationBranch}^{commit}`,
    ]),
    probe(`status`, ['status', '--porcelain=v1']),
    probe(`recent log on ${branch}`, [
      'log',
      '--oneline',
      '-n',
      '3',
      branch,
    ]),
  ])
  return lines.join('\n')
}

export const checkBranchHasDiff = async (
  cwd: string,
  branch: string,
  integrationBranch: string,
  traceCtx?: TraceCtx,
): Promise<VerifyStep> => {
  const verifyCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'verify' }
    : undefined
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['rev-list', '--count', `${integrationBranch}..${branch}`],
      { cwd },
      verifyCtx,
    )
    const count = Number.parseInt(stdout.trim(), 10)
    if (!Number.isInteger(count) || count <= 0) {
      // Zero commits ahead is benign, not a failure. `integration..branch == 0`
      // means every commit reachable from the branch is already reachable from
      // integration — i.e. the branch tip is an ancestor of, or equal to,
      // integration. Two sub-shapes, both fine:
      //
      //   - tip != integration → the branch's commit already fast-forwarded
      //     into integration between this task's setup and this check (the
      //     late-merge / runClaudeCode timeout-leak class). Work shipped.
      //   - tip == integration → either the just-merged commit lands the tip
      //     exactly on integration, or the agent legitimately concluded there
      //     was nothing to do. This is the main-committer no-op: the dirty
      //     state it was spawned to clean was already resolved upstream, so it
      //     leaves the integration branch clean — its success condition. (An
      //     empty `recover(noop)` commit collapses to this shape once merged.)
      //
      // In every case the integration branch already contains everything the
      // task produced and is clean: there is no un-integrated work to lose and
      // no dirty tree, so failing the task would recover nothing and only
      // strand any chain blocked on it (the 2026-05-29 main-committer incident,
      // where a correct no-op was failed as verify:has-diff/no-commits-ahead).
      // Pass. The diagnostics still ride along so a post-mortem can tell a
      // no-op apart from real shipped work without re-shelling into the tree.
      const branchSha = (
        await exec(
          resolveGitBin(),
          ['rev-parse', '--verify', `${branch}^{commit}`],
          { cwd },
          verifyCtx,
        )
      ).stdout.trim()
      const integrationSha = (
        await exec(
          resolveGitBin(),
          ['rev-parse', '--verify', `${integrationBranch}^{commit}`],
          { cwd },
          verifyCtx,
        )
      ).stdout.trim()
      const diagnostics = await captureHasDiffDiagnostics(
        cwd,
        branch,
        integrationBranch,
        verifyCtx,
      )
      const summary =
        branchSha === integrationSha
          ? `branch ${branch} tip equals ${integrationBranch} — no un-integrated work, tree clean (no-op accepted)`
          : `branch ${branch} is an ancestor of ${integrationBranch} — work already merged`
      return {
        name: 'has-diff',
        passed: true,
        output: `${summary}\n${diagnostics}`,
      }
    }
    return { name: 'has-diff', passed: true, output: `${count} commit(s) ahead of ${integrationBranch}` }
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    const msg = e.message ?? ''
    // runTool surfaces "working directory no longer exists: <path>" when the
    // spawn's cwd is absent. Propagate that as a distinct, named failure so a
    // post-mortem can immediately distinguish a deleted worktree from a git
    // binary that is missing from PATH — both produce the same raw ENOENT.
    const cwdMissingMatch = /working directory no longer exists: (.+)/.exec(msg)
    if (cwdMissingMatch) {
      return {
        name: 'has-diff',
        passed: false,
        output: `worktree path ${cwdMissingMatch[1].replace(/\)$/, '')} no longer exists`,
      }
    }
    return {
      name: 'has-diff',
      passed: false,
      output: `git rev-list failed: ${(e.stderr ?? '') + msg}`,
    }
  }
}

export interface CleanWorktreeArgs {
  worktreePath: string
  integrationBranch: string
  /** Optional trace context piped through to the git invocations. */
  traceCtx?: TraceCtx
}

export interface CleanWorktreeResult {
  cleaned: boolean
  reason: string
  output: string
}

/**
 * Remove stray untracked files from a task worktree before re-invoking
 * the coder, BUT only when the branch is still 0 commits ahead of the
 * integration branch. The 0-commits-ahead gate distinguishes "debris
 * from a prior failed attempt that exited without committing" (clean
 * it) from "real work the agent committed on a previous turn" (leave
 * it alone — those commits ARE the worktree's state).
 *
 * Background: when a source task is re-dispatched after a recovery
 * fix-task unblocks it, the orchestrator reuses the original branch+
 * worktree (see {@link createWorktree}'s reuse path). The reused
 * worktree may carry untracked files the previous Coder wrote and never
 * staged — including misnested paths like
 * `orchestrator/orchestrator/...` — which the new agent then spends
 * turns inspecting before getting to the actual work.
 *
 * Honours .gitignore (no `-x`), so `node_modules/` (already populated
 * by the install step) and `.mars/` are preserved either way.
 */
export const cleanWorktreeIfNoCommitsAhead = async (
  args: CleanWorktreeArgs,
): Promise<CleanWorktreeResult> => {
  const ctx = args.traceCtx
  let count: number
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['rev-list', '--count', `${args.integrationBranch}..HEAD`],
      { cwd: args.worktreePath },
      ctx,
    )
    count = Number.parseInt(stdout.trim(), 10)
    if (!Number.isInteger(count)) {
      return {
        cleaned: false,
        reason: `rev-list emitted non-integer count: ${stdout.trim()}`,
        output: '',
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      cleaned: false,
      reason: `rev-list ${args.integrationBranch}..HEAD failed: ${message}`,
      output: '',
    }
  }

  if (count > 0) {
    return {
      cleaned: false,
      reason: `branch is ${count} commit(s) ahead of ${args.integrationBranch}; preserving worktree state`,
      output: '',
    }
  }

  try {
    const { stdout, stderr } = await exec(
      resolveGitBin(),
      ['clean', '-fd'],
      { cwd: args.worktreePath },
      ctx,
    )
    return {
      cleaned: true,
      reason: `branch is 0 commits ahead of ${args.integrationBranch}; removed untracked debris`,
      output: stdout + stderr,
    }
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    return {
      cleaned: false,
      reason: `git clean -fd failed: ${e.message ?? ''}`,
      output: (e.stdout ?? '') + (e.stderr ?? ''),
    }
  }
}

export const verifyChanges = async (
  args: VerifyArgs,
): Promise<{ passed: boolean; steps: VerifyStep[] }> => {
  const verifyCtx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'verify' }
    : undefined
  if (args.branch && args.integrationBranch) {
    const diffStep = await checkBranchHasDiff(
      args.cwd,
      args.branch,
      args.integrationBranch,
      verifyCtx,
    )
    if (!diffStep.passed) {
      return { passed: false, steps: [diffStep] }
    }
  }

  const results: VerifyStep[] = []
  let stoppedOnRequired = false
  for (const spec of args.steps) {
    // Integration-tier steps are always deferred to the integration boundary —
    // they are NOT run during the per-task verify phase. Record them as deferred
    // with a trace note so the run-timeline view can surface them.
    if (spec.tier === 'integration') {
      results.push({
        name: spec.name,
        tier: 'integration',
        passed: true,
        output: 'deferred to integration — runs at integration boundary',
      })
      continue
    }

    if (stoppedOnRequired && spec.required) continue
    // Each step runs in its own scope directory rather than from one
    // flattened working directory: the root scope ('.' or unset) runs in
    // the verify root; a narrower scope runs in its subdirectory.
    const stepCwd =
      spec.dir && spec.dir !== '.' ? resolve(args.cwd, spec.dir) : args.cwd

    // Pre-flight tsc-presence guard: skip `npx tsc` steps when no real
    // TypeScript toolchain is detected in the step directory. A real
    // toolchain requires both a tsconfig.json (the project is configured
    // for TypeScript) and a locally-installed tsc binary. Without the
    // local binary, `npx tsc` resolves to the npm decoy package and emits
    // "This is not the tsc command you are looking for" rather than
    // running an actual typecheck. Skipping avoids a spurious required-
    // step failure in Kotlin/Gradle or other non-TypeScript repos.
    if (isNpxTscStep(spec)) {
      const hasTsconfig = existsSync(resolve(stepCwd, 'tsconfig.json'))
      // Check both the step dir and one level up (workspace/monorepo hoist).
      const hasBin =
        existsSync(resolve(stepCwd, 'node_modules', '.bin', 'tsc')) ||
        existsSync(resolve(stepCwd, '..', 'node_modules', '.bin', 'tsc'))
      if (!hasTsconfig || !hasBin) {
        results.push({
          name: spec.name,
          tier: 'task',
          passed: true,
          output: `typecheck skipped: no real TypeScript toolchain detected in ${stepCwd} (tsconfig.json present: ${hasTsconfig}, local tsc binary found: ${hasBin})`,
          cmd: spec.cmd,
          args: [...spec.args],
          stepDir: stepCwd,
        })
        continue
      }
    }

    const stepStart = performance.now()
    const result = await runVerifyStep(
      spec.name,
      spec.cmd,
      spec.args,
      stepCwd,
      verifyCtx,
    )
    const duration = Math.round(performance.now() - stepStart)

    // Post-flight decoy guard: if `npx tsc` exited non-zero with the
    // well-known placeholder message, treat it as a skip rather than a
    // code-level typecheck failure. This is a misconfiguration signal —
    // the TypeScript package is not properly installed — not an actual
    // type error that the agent should attempt to fix.
    if (isNpxTscStep(spec) && !result.passed && result.output.includes(TSC_DECOY_MARKER)) {
      results.push({
        ...result,
        tier: 'task',
        duration,
        passed: true,
        output: `typecheck skipped (decoy tsc detected — TypeScript not installed): ${result.output}`,
      })
      continue
    }

    results.push({ ...result, tier: 'task', duration })
    if (!result.passed && spec.required) {
      stoppedOnRequired = true
    }
  }

  const requiredFailed = args.steps.some((spec, i) => {
    // Integration-tier steps are always deferred (passed:true) and never block
    if (spec.tier === 'integration') return false
    const r = results[i]
    return spec.required && r && !r.passed
  })
  return { passed: !requiredFailed && !stoppedOnRequired, steps: results }
}

interface ManifestSupervisorEntry {
  name?: string
  scope?: string
  verify?: ReadonlyArray<{
    name: string
    cmd: string
    args: readonly string[]
    required?: boolean
    tier?: string
  }>
}

interface SupervisorsManifest {
  supervisors?: ReadonlyArray<ManifestSupervisorEntry>
}

// Normalise a recipe scope to the canonical form used as the scope key:
// '.' is the repo-root scope; anything else is slash-separated, no
// leading './', no trailing '/'. An absent/empty scope is the root.
const normalizeScope = (scope: string | undefined): string => {
  if (!scope) return '.'
  const s = scope
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  return s === '' || s === '.' ? '.' : s
}

// Path-containment test: is `file` (a repo-root-relative path) inside the
// subtree `scope`? The root scope contains every file.
const fileInScope = (file: string, scope: string): boolean => {
  if (scope === '.') return true
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '')
  return f === scope || f.startsWith(`${scope}/`)
}

/**
 * Load the recipe's verify steps grouped by scope. Unlike the previous
 * collapse-by-name behaviour, two scopes that declare a step with the
 * same name are kept as distinct entries — each scope owns its steps and
 * its directory. Within a single scope a repeated step name keeps the
 * first occurrence. A missing, unparseable, or verify-less manifest
 * yields no scopes (no-op pass) — defining verification steps is the
 * user's responsibility via the supervisors manifest.
 */
export const loadVerifyScopes = async (
  manifestPath: string,
): Promise<VerifyScope[]> => {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  let parsed: SupervisorsManifest
  try {
    parsed = JSON.parse(raw) as SupervisorsManifest
  } catch {
    return []
  }
  const supervisors = parsed.supervisors ?? []
  const byScope = new Map<string, Map<string, VerifyStepSpec>>()
  const order: string[] = []
  for (const sup of supervisors) {
    const verify = sup.verify
    if (!verify || verify.length === 0) continue
    const scope = normalizeScope(sup.scope)
    let steps = byScope.get(scope)
    if (!steps) {
      steps = new Map()
      byScope.set(scope, steps)
      order.push(scope)
    }
    for (const v of verify) {
      if (steps.has(v.name)) continue
      const tier: 'task' | 'integration' | undefined =
        v.tier === 'task' || v.tier === 'integration' ? v.tier : undefined
      steps.set(v.name, {
        name: v.name,
        cmd: v.cmd,
        args: [...v.args],
        required: v.required ?? true,
        dir: scope,
        ...(tier !== undefined ? { tier } : {}),
      })
    }
  }
  if (byScope.size === 0) return []
  return order.map((scope) => ({
    scope,
    steps: Array.from(byScope.get(scope)!.values()),
  }))
}

/**
 * Select the verify steps to run for a task from the recipe scopes and
 * the files the task actually changed. The root scope ('.') is an
 * always-on floor; every narrower scope whose subtree contains at least
 * one changed file is layered on top. Root steps come first, then the
 * matched narrower scopes in declared order. Each returned step carries
 * the `dir` of its scope so {@link verifyChanges} runs it where it
 * belongs.
 */
export const selectVerifySteps = (
  scopes: ReadonlyArray<VerifyScope>,
  changedFiles: ReadonlyArray<string>,
): VerifyStepSpec[] => {
  const roots = scopes.filter((s) => s.scope === '.')
  const rest = scopes.filter((s) => s.scope !== '.')
  const selected: VerifyStepSpec[] = []
  for (const sc of [...roots, ...rest]) {
    const matched =
      sc.scope === '.' ||
      changedFiles.some((f) => fileInScope(f, sc.scope))
    if (!matched) continue
    for (const step of sc.steps) {
      selected.push({ ...step, dir: sc.scope })
    }
  }
  return selected
}

// ---------------------------------------------------------------------------
// Completeness gate — always-on, tier: 'task'
// ---------------------------------------------------------------------------

/**
 * Arguments for {@link checkCompletenessGate}.
 *
 * Injected at the call site in the verify primitive so the gate can work
 * without loading task rows or a DB handle.
 */
export interface CompletenessGateArgs {
  /** Full concatenated text from the coder's transcript (all assistant + result events). */
  coderText: string
  /** Repo-root-relative paths of files changed by this task (from `git diff --name-only`). */
  changedFiles: ReadonlyArray<string>
  /** Absolute path to the task's git worktree root. */
  worktreePath: string
  /** The task branch (for commit SHA reachability checks). */
  branch: string
  /** Optional trace context. */
  traceCtx?: TraceCtx
}

/**
 * Returns true when the file path looks like a test/spec file that may
 * exist pre-task (not necessarily in the diff).
 */
const isTestFilePath = (filePath: string): boolean =>
  /\.(test|spec)\.[a-zA-Z0-9]+$/.test(filePath) ||
  filePath.includes('__tests__') ||
  filePath.includes('/__test__/') ||
  filePath.includes('/test/')

/**
 * Normalise a file path: forward slashes only, strip any leading `./`.
 */
const normalizeFilePath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^\.\//, '')

// Matches the full evidence string as a commit SHA (7–40 hex chars).
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i

// Matches `path/to/file.ext` or `path/to/file.ext:42` — a path ending in a
// dotted extension, optionally followed by a colon and line number.
const FILE_PATH_RE = /^([^\s]+\.[a-zA-Z0-9]{1,10})(:\d+)?$/

/**
 * Spot-check one evidence string against physical reality.
 *
 *  - Commit SHA  → object must exist in the repo (`git cat-file -e <sha>^{commit}`).
 *  - File path   → regular files must appear in the diff; test files must exist on disk.
 *  - Anything else (test names, descriptions) → accepted without a check.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason: string }`.
 */
const checkEvidenceClaim = async (
  evidence: string,
  changedFiles: ReadonlyArray<string>,
  worktreePath: string,
  _branch: string,
  traceCtx?: TraceCtx,
): Promise<{ ok: boolean; reason?: string }> => {
  const trimmed = evidence.trim()

  // ── Commit SHA ──────────────────────────────────────────────────────────
  if (COMMIT_SHA_RE.test(trimmed)) {
    try {
      const r = await execProbe(
        resolveGitBin(),
        ['cat-file', '-e', `${trimmed}^{commit}`],
        { cwd: worktreePath },
        traceCtx,
      )
      if (r.exitCode === 0) return { ok: true }
      return { ok: false, reason: `commit ${trimmed} not found in repository` }
    } catch {
      return { ok: false, reason: `could not verify commit ${trimmed}` }
    }
  }

  // ── File path (with optional :line suffix) ───────────────────────────
  const fileMatch = FILE_PATH_RE.exec(trimmed)
  if (fileMatch) {
    const filePath = normalizeFilePath(fileMatch[1])

    if (isTestFilePath(filePath)) {
      // Test files may be pre-existing — just check they exist on disk.
      const fullPath = resolve(worktreePath, filePath)
      if (existsSync(fullPath)) return { ok: true }
      // Try matching against changedFiles as a fallback (e.g. newly added test).
      if (changedFiles.some((cf) => cf === filePath || cf.endsWith('/' + filePath))) {
        return { ok: true }
      }
      return {
        ok: false,
        reason: `test file "${filePath}" does not exist in the worktree`,
      }
    }

    // Regular files must appear in the task's diff.
    if (
      changedFiles.some(
        (cf) =>
          cf === filePath ||
          cf.endsWith('/' + filePath) ||
          filePath.endsWith('/' + cf),
      )
    ) {
      return { ok: true }
    }
    // Also accept if the file actually exists in the worktree — covers cases
    // where the path is absolute or the diff list is incomplete.
    const fullPath = resolve(worktreePath, filePath)
    if (existsSync(fullPath)) return { ok: true }

    return {
      ok: false,
      reason: `file "${filePath}" is not in the task's changed files and does not exist in the worktree`,
    }
  }

  // ── Non-verifiable evidence (test names, descriptions) ──────────────────
  return { ok: true }
}

/**
 * Always-on completeness gate (tier: 'task').
 *
 * Parses the coder's completion report from the persisted transcript text
 * and returns a {@link VerifyStep} with one of four verdicts:
 *
 *  - `passed: false`, output starts with `missing-completion-report:` —
 *    the report is absent or malformed.
 *  - `passed: false`, output starts with `incomplete:` —
 *    one or more criteria are `partial` or `blocked`.
 *  - `passed: false`, output starts with `unsubstantiated-completion:` —
 *    all criteria are `done` but at least one evidence claim cannot be
 *    verified against the diff / on-disk state / git history.
 *  - `passed: true` — all criteria done and every verifiable claim confirmed.
 *
 * No LLM call is made anywhere in this gate.
 */
export const checkCompletenessGate = async (
  args: CompletenessGateArgs,
): Promise<VerifyStep> => {
  const { coderText, changedFiles, worktreePath, branch, traceCtx } = args

  const report = parseCompletionReport(coderText)

  // ── Verdict 1: missing or unparseable ───────────────────────────────────
  if (report.kind === 'absent') {
    return {
      name: 'completeness',
      passed: false,
      tier: 'task',
      output:
        'missing-completion-report: no completion-report fenced block found in the coder\'s final message.\n' +
        'Ensure the FINAL message ends with a ```completion-report block as required by the task contract.',
    }
  }
  if (report.kind === 'unparseable') {
    return {
      name: 'completeness',
      passed: false,
      tier: 'task',
      output:
        `missing-completion-report: a completion-report block was found but could not be parsed (malformed lines).\n` +
        `Every line must match: - [done|partial|blocked] <criterion> — evidence: <evidence>\n` +
        `(the 'evidence:' keyword is optional; '- [done] <criterion> — <evidence>' is also accepted)\n` +
        `Raw block:\n${report.raw}`,
    }
  }

  // ── Verdict 2: partial or blocked criteria ───────────────────────────────
  const unmetLines = report.lines.filter((l) => l.status !== 'done')
  if (unmetLines.length > 0) {
    const detail = unmetLines
      .map((l) => `  - [${l.status}] ${l.criterion} — evidence: ${l.evidence}`)
      .join('\n')
    return {
      name: 'completeness',
      passed: false,
      tier: 'task',
      output:
        `incomplete: ${unmetLines.length} criterion/criteria not marked done.\n` +
        `Unmet criteria (the recovery Chore must address these):\n${detail}`,
    }
  }

  // ── Verdict 3: evidence spot-check ──────────────────────────────────────
  const unsubstantiated: string[] = []
  for (const line of report.lines) {
    const check = await checkEvidenceClaim(
      line.evidence,
      changedFiles,
      worktreePath,
      branch,
      traceCtx,
    )
    if (!check.ok) {
      unsubstantiated.push(
        `  - ${line.criterion}: evidence "${line.evidence}" — ${check.reason}`,
      )
    }
  }
  if (unsubstantiated.length > 0) {
    return {
      name: 'completeness',
      passed: false,
      tier: 'task',
      output:
        `unsubstantiated-completion: ${unsubstantiated.length} evidence claim(s) could not be verified.\n` +
        `Unsubstantiated claims (the recovery Chore must provide real evidence):\n${unsubstantiated.join('\n')}`,
    }
  }

  // ── Verdict 4: pass ─────────────────────────────────────────────────────
  return {
    name: 'completeness',
    passed: true,
    tier: 'task',
    output: `all ${report.lines.length} criterion/criteria done and evidence verified`,
  }
}

/**
 * The files a task changed between the integration branch and its task
 * branch, as repo-root-relative slash-separated paths. Empty on any git
 * failure so verification still runs (the root floor) rather than
 * crashing the verify step.
 */
export const getChangedFiles = async (
  cwd: string,
  integrationBranch: string,
  branch: string,
  traceCtx?: TraceCtx,
): Promise<string[]> => {
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['diff', '--name-only', `${integrationBranch}..${branch}`],
      { cwd },
      traceCtx,
    )
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

