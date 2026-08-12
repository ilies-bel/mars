import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  exec,
  execProbe,
  resolveGitBin,
  type TraceCtx,
} from './internal'
import { assertWorktreeHygieneForVerify } from '../verify'
import { classifyTypecheckOutput } from '../failure-signature'

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
  /** Stable verify_gates.id for a registry-backed step. */
  gateId?: string
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
  /**
   * Raw exit code from the subprocess. `null` when the abort signal killed
   * the process before it could exit normally. Absent on deferred
   * integration-tier steps and built-in gates that do not shell out.
   */
  exitCode?: number | null
  /**
   * Raw stdout from the subprocess, without any prefix added by the verify
   * layer. Absent on deferred integration-tier steps and built-in gates.
   */
  stdout?: string
  /**
   * Raw stderr from the subprocess, without any prefix added by the verify
   * layer. Absent on deferred integration-tier steps and built-in gates.
   */
  stderr?: string
  /**
   * The command as a single displayable string. For registry steps this is
   * `[cmd, ...args].join(' ')`. For spec verifyCmd steps ({@link SPEC_VERIFY_CMD_STEP})
   * this is the raw command string from the task spec (e.g. `"npm test"`),
   * not `sh -c npm test`. Absent on deferred integration-tier steps and
   * built-in gates that do not shell out.
   */
  commandLine?: string
}

export interface VerifyStepSpec {
  name: string
  /** Stable verify_gates.id for a registry-backed step. */
  gateId?: string
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
  /**
   * Repo-relative paths the task branch changed. The review primitive uses
   * them to choose root and path-covered verify scopes; verifyChanges uses
   * them to make a missing task-tier gate explicit as CAN'T-VERIFY.
   */
  changedFiles?: ReadonlyArray<string>
  /**
   * Optional cancellation signal. When the signal fires, any in-flight step
   * subprocess is SIGTERM'd (then SIGKILL'd after a 2s grace), the step is
   * recorded as `passed: false` with a "killed by abort signal" marker, and
   * subsequent steps are skipped immediately rather than started.
   *
   * Used by `integrationGateRunner` (primitives/index.ts) to bound the gate's
   * hold on the merge lock: an `AbortController` fires at
   * `INTEGRATION_GATE_TIMEOUT_MS` (~120s) so a hung test suite fails the gate
   * fast instead of occupying `.merge.lock` for the full 300s merge watchdog.
   */
  signal?: AbortSignal
  /**
   * Raw shell command string from the task spec (e.g. `"npm test"` or
   * `"cd orchestrator && npm run typecheck"`). When non-empty, executed
   * verbatim via `sh -c` as a required verify step immediately after the
   * has-diff / worktree-hygiene gates and before any registry gate steps.
   * A non-zero exit fails the verify phase and prevents registry steps from
   * running. Its exit code and the raw command string are both recorded on
   * the resulting {@link VerifyStep} (step name: {@link SPEC_VERIFY_CMD_STEP}).
   *
   * **Synthetic-step alternative**: consumers may instead append a
   * `VerifyStepSpec` with `name: 'spec.verifyCmd'`, `cmd: 'bash'`,
   * `args: ['-o', 'pipefail', '-c', <cmd>]`, `required: true`, and
   * `tier: 'task'` directly to `args.steps`. The `bash -o pipefail` shell
   * propagates the leftmost non-zero exit from any pipeline and the step
   * counts as task-tier coverage for the `cant-verify:no-gate-coverage` check.
   * This is the preferred form when the consumer controls step ordering —
   * e.g. the `review` primitive (primitives/index.ts) appends it after
   * registry gate steps so the operator-declared command is always the last
   * gate visible in `verifyOutput`.
   */
  verifyCmd?: string | null
}

export type VerifyVerdict = 'PASS' | 'FAIL' | "CAN'T-VERIFY"

/**
 * The task-level verification decision. A CAN'T-VERIFY verdict still permits
 * merge: it makes missing task-gate coverage observable without treating a
 * broken or incomplete gate registry as a pipeline-stopping failure.
 */
export interface VerifyResult {
  passed: boolean
  verdict: VerifyVerdict
  steps: VerifyStep[]
}

const runVerifyStep = async (
  name: string,
  gateId: string | undefined,
  cmd: string,
  args: readonly string[],
  cwd: string,
  traceCtx?: TraceCtx,
  signal?: AbortSignal,
): Promise<VerifyStep> => {
  const verifyCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'verify' }
    : undefined
  const r = await execProbe(cmd, [...args], { cwd, signal }, verifyCtx)
  const commandLine = [cmd, ...args].join(' ')
  if (r.exitCode === 0) {
    return {
      name,
      ...(gateId !== undefined ? { gateId } : {}),
      passed: true,
      output: r.stdout + r.stderr,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      cmd,
      args,
      stepDir: cwd,
      commandLine,
    }
  }
  // When the abort signal fired and killed the subprocess, prefix the output
  // with a clear marker so post-mortems can distinguish a timeout-kill from a
  // genuine test failure (the subprocess output alone may be empty or partial).
  // Raw stdout/stderr are kept unprefixed so callers can inspect them directly.
  const rawOutput = r.stdout + r.stderr
  const output =
    signal?.aborted
      ? `step killed by abort signal\n${rawOutput}`
      : r.exitCode === 143
        ? `verify child killed by SIGTERM (exit 143)\n${rawOutput}`
        : r.exitCode === 137
          ? `verify child killed by SIGKILL (exit 137)\n${rawOutput}`
          : rawOutput
  return {
    name,
    ...(gateId !== undefined ? { gateId } : {}),
    passed: false,
    output,
    exitCode: signal?.aborted ? null : r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    cmd,
    args,
    stepDir: cwd,
    commandLine,
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

/**
 * Step name for a pre-verify worktree-hygiene failure (missing directory,
 * wrong branch checked out, stale rebase state). Distinct from `has-diff`,
 * which is a verdict about the branch's DIFF — conflating them made every
 * hygiene problem read as a diff problem.
 */
export const WORKTREE_HYGIENE_STEP = 'worktree-hygiene'

/**
 * Step name for the required verify step that executes `spec.verifyCmd`
 * verbatim (via `sh -c`) during the per-task verify phase. Distinct from
 * registry gate steps so post-mortems can identify it without parsing the
 * command string.
 */
export const SPEC_VERIFY_CMD_STEP = 'spec-verify-cmd'

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
): Promise<VerifyResult> => {
  const verifyCtx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'verify' }
    : undefined

  // Pre-verify hygiene probe: validate that the worktree directory still
  // exists, the expected branch is checked out, and no stale rebase state is
  // present.  Any failure here aborts immediately — the diff / typecheck /
  // test sub-checks below would either produce misleading output or crash.
  if (args.branch) {
    try {
      await assertWorktreeHygieneForVerify(args.cwd, args.branch, verifyCtx)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Report under its OWN name, not `has-diff`. Labelling every hygiene
      // failure `has-diff` meant a missing worktree, a wrong checked-out
      // branch and stale rebase state all surfaced as
      // `verify:has-diff failed` — on a diff that was never examined — which
      // turned a log read into a forensics exercise more than once.
      return {
        passed: false,
        verdict: 'FAIL',
        steps: [{ name: WORKTREE_HYGIENE_STEP, passed: false, output: msg }],
      }
    }
  }

  // Declare results before the has-diff block so the passing gate can be
  // included in the output (making gate-outcomes show what actually ran).
  const results: VerifyStep[] = []

  if (args.branch && args.integrationBranch) {
    const diffStep = await checkBranchHasDiff(
      args.cwd,
      args.branch,
      args.integrationBranch,
      verifyCtx,
    )
    if (!diffStep.passed) {
      return { passed: false, verdict: 'FAIL', steps: [diffStep] }
    }
    // Include the passing has-diff gate in results so gate-outcomes correctly
    // reflects what ran rather than silently dropping built-in gates that pass.
    results.push(diffStep)
  }

  // Execute spec.verifyCmd verbatim as a required step when present. Runs
  // after the has-diff / worktree-hygiene gates and before registry gate steps
  // so a failing focused test blocks the task immediately without running
  // heavier package-wide gates on top of it.
  //
  // The command is passed to `sh -c` verbatim to support shell features such
  // as `cd subdir && npm test`. The raw command string (not `sh -c …`) is
  // stored on the VerifyStep as `commandLine` so reproduce hints show exactly
  // what the task author wrote.
  const verifyCmdRaw = args.verifyCmd?.trim() ?? ''
  if (verifyCmdRaw.length > 0) {
    if (args.signal?.aborted) {
      results.push({
        name: SPEC_VERIFY_CMD_STEP,
        tier: 'task',
        passed: false,
        output: 'step not started: abort signal already fired',
        commandLine: verifyCmdRaw,
        stepDir: args.cwd,
      })
      return { passed: false, verdict: 'FAIL', steps: results }
    }
    const cmdStart = performance.now()
    const cmdResult = await runVerifyStep(
      SPEC_VERIFY_CMD_STEP,
      undefined,
      'sh',
      ['-c', verifyCmdRaw],
      args.cwd,
      verifyCtx,
      args.signal,
    )
    const cmdDuration = Math.round(performance.now() - cmdStart)
    // Override commandLine to show the raw spec command, not 'sh -c <cmd>',
    // so callers see what the task author wrote rather than the implementation detail.
    results.push({ ...cmdResult, tier: 'task', duration: cmdDuration, commandLine: verifyCmdRaw })
    if (!cmdResult.passed) {
      return { passed: false, verdict: 'FAIL', steps: results }
    }
  }

  // A non-empty task diff without a selected task-tier gate must be visible,
  // but must not wedge the pipeline. Integration gates are intentionally
  // deferred and do not count as task-tier coverage.
  // spec.verifyCmd also counts as task-tier coverage when present — it ran
  // above and is a real gate, not a deferred one.
  const hasTaskTierGate =
    args.steps.some((spec) => spec.tier !== 'integration') || verifyCmdRaw.length > 0
  const lacksTaskTierCoverage =
    (args.changedFiles?.length ?? 0) > 0 && !hasTaskTierGate
  if (lacksTaskTierCoverage) {
    results.push({
      name: 'cant-verify:no-gate-coverage',
      tier: 'task',
      passed: true,
      output: "CAN'T-VERIFY: no task-tier verify gate covers the changed files",
    })
  }

  let stoppedOnRequired = false
  for (const spec of args.steps) {
    // Integration-tier steps are always deferred to the integration boundary —
    // they are NOT run during the per-task verify phase. Record them as deferred
    // with a trace note so the run-timeline view can surface them.
    if (spec.tier === 'integration') {
      results.push({
        name: spec.name,
        ...(spec.gateId !== undefined ? { gateId: spec.gateId } : {}),
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

    // Abort-signal short-circuit: if the signal has already fired before this
    // step starts, record it as failed immediately without spawning a subprocess.
    // This happens for steps queued after a step that was killed mid-run.
    if (args.signal?.aborted) {
      results.push({
        name: spec.name,
        ...(spec.gateId !== undefined ? { gateId: spec.gateId } : {}),
        tier: 'task',
        passed: false,
        output: 'step not started: abort signal already fired',
        cmd: spec.cmd,
        args: [...spec.args],
        stepDir: stepCwd,
      })
      if (spec.required) stoppedOnRequired = true
      continue
    }

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
      const hasWorkspaceManifest = existsSync(resolve(stepCwd, 'package.json'))
      const hasWorkspaceModules = existsSync(resolve(stepCwd, 'node_modules'))
      // Check both the step dir and one level up (workspace/monorepo hoist).
      const hasBin =
        existsSync(resolve(stepCwd, 'node_modules', '.bin', 'tsc')) ||
        existsSync(resolve(stepCwd, '..', 'node_modules', '.bin', 'tsc'))
      // A TypeScript workspace without its own module tree is not a
      // non-TypeScript project. It is a git-created/recreated worktree whose
      // dependencies were never provisioned. Fail before invoking tsc so the
      // operator sees the repair rather than TS2688 / TS2307 noise.
      if (hasTsconfig && hasWorkspaceManifest && !hasWorkspaceModules) {
        // Set stderr (not just output) so the message survives the structured
        // firstFailedOutput assembly in primitives/index.ts (which reads stderr
        // and stdout, not the combined output field, for steps that have a cmd).
        // Without this, classifyError sees only the step name as the first line
        // and falls through to `unclassified` instead of `typecheck-infra`.
        const _depMsg =
          `worktree deps not provisioned: ${stepCwd}/node_modules is missing — ` +
          'run mars restart <task-id> to recreate the worktree with dependencies'
        results.push({
          name: spec.name,
          ...(spec.gateId !== undefined ? { gateId: spec.gateId } : {}),
          tier: 'task',
          passed: false,
          output: _depMsg,
          stderr: _depMsg,
          cmd: spec.cmd,
          args: [...spec.args],
          stepDir: stepCwd,
        })
        if (spec.required) stoppedOnRequired = true
        continue
      }
      if (!hasTsconfig || !hasBin) {
        results.push({
          name: spec.name,
          ...(spec.gateId !== undefined ? { gateId: spec.gateId } : {}),
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
      spec.gateId,
      spec.cmd,
      spec.args,
      stepCwd,
      verifyCtx,
      args.signal,
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

    // Infra-retry for tsc steps: if the failure contains no TypeScript error
    // codes, the environment is likely the culprit (missing modules, ENOENT,
    // OOM, etc.).  Attempt a dep refresh and retry once.  A real type error
    // fails both runs (dep refresh cannot change compiled code), so one retry
    // cannot mask a genuine bug.  Do NOT add a retry budget beyond one.
    if (isNpxTscStep(spec) && !result.passed && classifyTypecheckOutput(result.output) === 'infra') {
      // Best-effort dep refresh: detect the package manager from the lockfile
      // and run the frozen install command.  Failure is silently ignored — the
      // retry below will fail for the same reason and be recorded as infra.
      {
        const _dirs = [stepCwd, resolve(stepCwd, '..')]
        let _pm: string | undefined
        let _installArgs: string[] | undefined
        for (const _d of _dirs) {
          if (existsSync(resolve(_d, 'pnpm-lock.yaml'))) { _pm = 'pnpm'; _installArgs = ['install', '--frozen-lockfile']; break }
          if (existsSync(resolve(_d, 'package-lock.json'))) { _pm = 'npm'; _installArgs = ['ci']; break }
          if (existsSync(resolve(_d, 'yarn.lock'))) { _pm = 'yarn'; _installArgs = ['install', '--frozen-lockfile']; break }
          if (existsSync(resolve(_d, 'bun.lockb'))) { _pm = 'bun'; _installArgs = ['install', '--frozen-lockfile']; break }
        }
        if (_pm && _installArgs) {
          try {
            await execProbe(_pm, _installArgs, { cwd: stepCwd }, verifyCtx)
          } catch {
            // best-effort: ignore refresh failures; the retry decides the outcome
          }
        }
      }
      const _retryStart = performance.now()
      const _retryResult = await runVerifyStep(
        spec.name,
        spec.gateId,
        spec.cmd,
        spec.args,
        stepCwd,
        verifyCtx,
        args.signal,
      )
      const _retryDuration = Math.round(performance.now() - _retryStart)
      if (_retryResult.passed) {
        // Retry succeeded: the infra condition was transient.  Record as passed.
        results.push({ ..._retryResult, tier: 'task', duration: _retryDuration })
        continue
      }
      // Retry also failed.  Distinguish infra (no TS codes) from a real type
      // error revealed by the dep refresh (dep refresh fixed the environment
      // and now tsc can run and reports real TS errors).
      if (classifyTypecheckOutput(_retryResult.output) === 'infra') {
        // Still infra after retry: add the sentinel so classifyError produces
        // `typecheck-infra` rather than `unclassified`.
        const _infraSentinel = `typecheck-infra: infra failure persisted after dep-refresh retry (exit ${_retryResult.exitCode ?? 'null'})`
        results.push({
          ..._retryResult,
          tier: 'task',
          duration: _retryDuration,
          stderr: _infraSentinel + (_retryResult.stderr ? '\n' + _retryResult.stderr : ''),
          output: _infraSentinel + '\n' + _retryResult.output,
        })
      } else {
        // Retry revealed a real type error: record as-is so the fix-task recipe
        // can address the actual TypeScript defect.
        results.push({ ..._retryResult, tier: 'task', duration: _retryDuration })
      }
      if (spec.required) stoppedOnRequired = true
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
  const passed = !requiredFailed && !stoppedOnRequired
  return {
    passed,
    verdict: !passed ? 'FAIL' : lacksTaskTierCoverage ? "CAN'T-VERIFY" : 'PASS',
    steps: results,
  }
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
 * Select task verify steps for changed paths. Root scope remains the always-on
 * floor; a narrower scope is selected only when at least one changed path is
 * inside that scope. Root steps run first and the remaining selected scopes
 * retain their declared order. Each returned step carries the `dir` of its
 * scope so {@link verifyChanges} runs it where it belongs.
 */
export const selectVerifySteps = (
  scopes: ReadonlyArray<VerifyScope>,
  changedFiles: ReadonlyArray<string>,
): VerifyStepSpec[] => {
  const roots = scopes.filter((s) => s.scope === '.')
  const rest = scopes.filter(
    (s) =>
      s.scope !== '.' &&
      changedFiles.some(
        (path) => path === s.scope || path.startsWith(`${s.scope}/`),
      ),
  )
  const selected: VerifyStepSpec[] = []
  for (const sc of [...roots, ...rest]) {
    for (const step of sc.steps) {
      selected.push({ ...step, dir: sc.scope })
    }
  }
  return selected
}

/**
 * The files a task changed on its own branch, as repo-root-relative
 * slash-separated paths. Empty on any git failure so verification still
 * runs (the root floor) rather than crashing the verify step.
 *
 * THREE dots, deliberately. `git diff A...B` diffs from the merge-base of
 * A and B to B — "what did B change since it forked" — which is the only
 * question this function is asking. Two-dot `A..B` is plain `git diff A B`:
 * it compares the two TIPS, so as soon as the task branch falls behind the
 * integration branch (the normal state here — tasks code in parallel while
 * `main` keeps moving) the output also contains every file the INTEGRATION
 * branch changed since the fork, rendered as reversals of work the task
 * never touched. Measured on this repo, a branch 1 commit ahead / 88 behind
 * reported 218 files under two-dot vs the 23 it actually changed.
 *
 * Callers use this information to choose only the verify gates whose scopes
 * contain paths changed by the task. The same two-dot trap has also produced
 * misleading `--stat` output during merges, where `main`'s newer commits show
 * up as deletions.
 *
 * Two-dot is still correct for "how far ahead is B" (`rev-list --count A..B`)
 * and for ranges on a single linear history — do not blanket-convert those.
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
      ['diff', '--name-only', `${integrationBranch}...${branch}`],
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
