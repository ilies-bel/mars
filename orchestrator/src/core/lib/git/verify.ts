import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  exec,
  execProbe,
  resolveGitBin,
  type TraceCtx,
} from './internal'
import { assertWorktreeHygieneForVerify } from '../verify'
import { detectMalformedGateArgs } from '../gate-args-validation'
import {
  classifyVerifyFailure,
  decideBeforeVerifyStep,
  planVerifyRetry,
} from '../../../registries/verify-heuristics'
import { VERIFY_TIMEOUT_MARKER } from './verify-markers'

/**
 * The runner's output contract. Re-exported (not redefined) from the leaf
 * `./verify-markers` so a heuristic can match against it without importing
 * the runner and closing an import cycle.
 */
export { VERIFY_TIMEOUT_MARKER }

/**
 * Default per-step verify timeout in minutes.
 *
 * Override for the whole process with `MARS_VERIFY_TIMEOUT_MIN=<number>`.
 * Per-gate overrides are stored in `verify_gates.timeout_min`.
 */
const VERIFY_STEP_TIMEOUT_MIN_DEFAULT: number = Number(
  process.env.MARS_VERIFY_TIMEOUT_MIN ?? 15,
)

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
  /**
   * Per-step wall-clock timeout in minutes. When the step runs longer than
   * this, it is SIGTERM'd then SIGKILL'd after a 10 s grace, and the step
   * is recorded as failed with a `VERIFY_TIMEOUT_MARKER` prefix so the
   * failure signature becomes `verify:timeout/<step-name>`.
   *
   * When absent the global default (`VERIFY_STEP_TIMEOUT_MIN_DEFAULT`,
   * env `MARS_VERIFY_TIMEOUT_MIN`, default 15 min) is used.
   */
  timeoutMin?: number
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
   * `VerifyStepSpec` with `name: 'spec-verify-cmd'`, `cmd: 'bash'`,
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
  /**
   * Optional callback invoked with each verify step's child process OS PID
   * immediately after the child is spawned. The daemon uses this to track
   * verify child liveness in the heartbeat so a hung verify runner (child dead
   * but runner still holding the slot) can be detected by the phantom-task
   * watchdog as `verify:runner-hung` rather than timing out via the normal
   * ceiling path.
   *
   * Called once per subprocess spawn (not per step — steps that skip shelling
   * out do not invoke this callback). When absent, verify runs without PID
   * tracking (pre-fix behaviour; watchdog falls back to the updatedAt ceiling).
   */
  onChildPid?: (pid: number) => void
  /**
   * Which provider/model produced the code under verification. Optional:
   * supplied by the caller (the Coder shell), never derived by verify.ts
   * itself. Echoed onto the returned {@link VerifyResult} unchanged — see
   * {@link VerifyModelAttribution} for why.
   */
  modelAttribution?: VerifyModelAttribution
}

type VerifyVerdict = 'PASS' | 'FAIL' | "CAN'T-VERIFY"

/**
 * Which provider/model produced the code a verify run is checking. Plain
 * serializable data (ADR-0097's Port acceptance test) — no live handles.
 *
 * verify.ts has no way to derive this itself; the caller (the Coder shell,
 * which knows which Worker/model ran) supplies it on {@link VerifyArgs} and
 * it is threaded through unchanged onto {@link VerifyResult}. This closes
 * the gap named in ADR-0097 ("One typed event emitter…"): verify output and
 * model attribution today live only in ephemeral trace_events (pruned at
 * ~30 days); carrying attribution on the result lets a durable write persist
 * both together instead of only the ephemeral trace.
 */
export interface VerifyModelAttribution {
  provider: string
  model: string
}

/**
 * The task-level verification decision. A CAN'T-VERIFY verdict still permits
 * merge: it makes missing task-gate coverage observable without treating a
 * broken or incomplete gate registry as a pipeline-stopping failure.
 */
export interface VerifyResult {
  passed: boolean
  verdict: VerifyVerdict
  steps: VerifyStep[]
  /**
   * Echoed from {@link VerifyArgs.modelAttribution} when the caller supplied
   * one. Absent when the caller did not (e.g. a verify run with no
   * associated Coder pass).
   */
  modelAttribution?: VerifyModelAttribution
}

/**
 * The Verifier Port contract that used to be declared here — `VerifierPort`
 * and `VerifyPortRequest` — now lives in `../../ports/verifier/types.ts` as
 * `Verifier` / `VerifierRunArgs` / `VerifierRunResult`, next to its registry
 * and its `local` implementation (which wraps {@link verifyChanges}).
 * Callers resolve a verifier through `ports/verifier/registry.ts`
 * (`resolveVerifier`) rather than importing this runner directly (ADR-0097).
 */

const runVerifyStep = async (
  name: string,
  gateId: string | undefined,
  cmd: string,
  args: readonly string[],
  cwd: string,
  traceCtx?: TraceCtx,
  signal?: AbortSignal,
  timeoutMs?: number,
  onChildPid?: (pid: number) => void,
): Promise<VerifyStep> => {
  // Per-step timeout: create a dedicated AbortSignal that fires after timeoutMs.
  // This is independent of the outer signal so timeouts can be distinguished
  // from intentional cancellations (e.g. the integration-gate abort signal).
  // run-tool escalates SIGTERM → SIGKILL after a 2 s grace when either signal
  // fires, matching the integration-gate kill path behaviour.
  let stepTimeoutSignal: AbortSignal | undefined
  if (timeoutMs !== undefined && timeoutMs > 0) {
    stepTimeoutSignal = AbortSignal.timeout(timeoutMs)
  }

  // Combine the outer signal with the per-step timeout signal so the
  // subprocess is killed when EITHER fires first.
  const effectiveSignal: AbortSignal | undefined =
    signal && stepTimeoutSignal
      ? AbortSignal.any([signal, stepTimeoutSignal])
      : signal ?? stepTimeoutSignal

  const verifyCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'verify' }
    : undefined
  const r = await execProbe(
    cmd,
    [...args],
    { cwd, signal: effectiveSignal, onPid: onChildPid },
    verifyCtx,
  )
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
  // Determine what caused the failure and prefix the output accordingly so
  // post-mortems and `computeFailureSignature` can distinguish:
  //   1. Per-step wall-clock timeout → VERIFY_TIMEOUT_MARKER prefix
  //      → failure signature: verify:timeout/<step-name>
  //      → triggers infra-retry (first timeout); second timeout is final
  //   2. Outer abort signal (integration-gate cancel, …) → abort-signal prefix
  //   3. SIGTERM / SIGKILL from an external source → exit-code markers
  //   4. Normal non-zero exit → raw output only
  //
  // Raw stdout/stderr are kept unprefixed on the VerifyStep so callers can
  // inspect them directly without stripping the prefix.
  const timedOut = stepTimeoutSignal?.aborted === true
  const rawOutput = r.stdout + r.stderr
  // Name the command and the remedy on the marker line itself (not a
  // trailing line): downstream consumers that recover this marker for the
  // failure signature (`review.ts`'s timeoutMarkerLine) keep only the first
  // line, so anything after a '\n' here never reaches the operator. A
  // full-suite verify command (`npm test`, a bare `vitest run`) is the most
  // common cause of a verify timeout — see mars-a98bec46 / mars-c1afdad3,
  // which both burned their full 900s budget and their one recovery attempt
  // on exactly this before the enqueue-time guard existed.
  const output = timedOut
    ? `${VERIFY_TIMEOUT_MARKER} ${timeoutMs!}ms (exit ${r.exitCode ?? 'null'}) running: ${commandLine} — a full-suite verify command is the usual cause; scope --verify to the files you touched, e.g. 'cd <dir> && npx vitest run <file>'\n${rawOutput}`
    : signal?.aborted
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
    // exitCode is null when killed abnormally (timeout or outer abort signal)
    // so callers can distinguish a killed step from a step that exited on its own.
    exitCode: timedOut || signal?.aborted ? null : r.exitCode,
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
const WORKTREE_HYGIENE_STEP = 'worktree-hygiene'

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
        modelAttribution: args.modelAttribution,
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
      return {
        passed: false,
        verdict: 'FAIL',
        steps: [diffStep],
        modelAttribution: args.modelAttribution,
      }
    }
    // Include the passing has-diff gate in results so gate-outcomes correctly
    // reflects what ran rather than silently dropping built-in gates that pass.
    results.push(diffStep)
  }

  // Per-step wall-clock timeout in milliseconds. Derived from the global
  // VERIFY_STEP_TIMEOUT_MIN_DEFAULT (env MARS_VERIFY_TIMEOUT_MIN, default 15 min).
  // Individual registry steps may override via spec.timeoutMin.
  const defaultTimeoutMs = VERIFY_STEP_TIMEOUT_MIN_DEFAULT * 60_000

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
      return {
        passed: false,
        verdict: 'FAIL',
        steps: results,
        modelAttribution: args.modelAttribution,
      }
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
      defaultTimeoutMs,
      args.onChildPid,
    )
    const cmdDuration = Math.round(performance.now() - cmdStart)
    // Override commandLine to show the raw spec command, not 'sh -c <cmd>',
    // so callers see what the task author wrote rather than the implementation detail.
    results.push({ ...cmdResult, tier: 'task', duration: cmdDuration, commandLine: verifyCmdRaw })
    if (!cmdResult.passed) {
      return {
        passed: false,
        verdict: 'FAIL',
        steps: results,
        modelAttribution: args.modelAttribution,
      }
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

    // Pre-flight malformed-args guard: if any arg element contains whitespace
    // and the command is a package runner (npm/pnpm/yarn/bunx/npx), the gate
    // was registered with a quoting mistake (e.g. args: ["run test:e2e"]
    // instead of ["run", "test:e2e"]). Executing it would produce a confusing
    // generic npm usage error rather than running the intended script.  Fail
    // immediately with a clear "malformed gate args" message so the gate-broken
    // alert is actionable rather than opaque.
    const malformedArgsMsg = detectMalformedGateArgs(spec.cmd, spec.args)
    if (malformedArgsMsg) {
      const msg = `malformed gate args: ${malformedArgsMsg}`
      results.push({
        name: spec.name,
        ...(spec.gateId !== undefined ? { gateId: spec.gateId } : {}),
        tier: 'task',
        passed: false,
        output: msg,
        stderr: msg,
        cmd: spec.cmd,
        args: [...spec.args],
        stepDir: stepCwd,
      })
      if (spec.required) stoppedOnRequired = true
      continue
    }

    // Pre-flight heuristic guard: a registered heuristic may decide this step
    // must not run here at all — the built-in `typescript-toolchain` skips an
    // `npx tsc` step in a repo with no TypeScript toolchain, and fails one in
    // a TypeScript worktree whose dependencies were never provisioned. The
    // runner applies the decision; it does not know what a toolchain is.
    const preStep = decideBeforeVerifyStep(spec, stepCwd)
    if (preStep) {
      results.push({
        name: spec.name,
        ...(spec.gateId !== undefined ? { gateId: spec.gateId } : {}),
        tier: 'task',
        passed: preStep.passed,
        output: preStep.output,
        ...(preStep.stderr !== undefined ? { stderr: preStep.stderr } : {}),
        cmd: spec.cmd,
        args: [...spec.args],
        stepDir: stepCwd,
      })
      if (!preStep.passed && spec.required) stoppedOnRequired = true
      continue
    }

    const stepStart = performance.now()
    // Per-step timeout: prefer the gate's own timeoutMin (from verify_gates.timeout_min),
    // falling back to the process-wide default (MARS_VERIFY_TIMEOUT_MIN, 15 min).
    const stepTimeoutMs =
      spec.timeoutMin !== undefined ? spec.timeoutMin * 60_000 : defaultTimeoutMs
    const result = await runVerifyStep(
      spec.name,
      spec.gateId,
      spec.cmd,
      spec.args,
      stepCwd,
      verifyCtx,
      args.signal,
      stepTimeoutMs,
      args.onChildPid,
    )
    const duration = Math.round(performance.now() - stepStart)

    // Post-flight classification: a registered heuristic may rule that this
    // failure is not a code failure at all. Only a `skip` verdict changes what
    // the runner records (the built-in `typescript-toolchain` returns one for
    // the npm decoy `tsc` placeholder — a misconfiguration signal, not a type
    // error the agent should try to fix). An `infra` verdict is advisory and
    // is consumed one level up, by the `review` primitive's suite-level retry.
    if (!result.passed) {
      const verdict = classifyVerifyFailure(result, spec)
      if (verdict?.kind === 'skip') {
        results.push({
          ...result,
          tier: 'task',
          duration,
          passed: true,
          output: verdict.output,
        })
        continue
      }
    }

    // Post-flight retry: a heuristic may ask for exactly one re-run of a
    // failing step, optionally repairing the environment first (the built-in
    // `typescript-toolchain` refreshes dependencies when a tsc failure carries
    // no TypeScript error codes). One retry, never a budget — a real defect
    // fails both runs, so a single retry cannot mask it.
    const retryPlan = result.passed ? undefined : planVerifyRetry(result, spec)
    if (retryPlan) {
      if (retryPlan.prepare) {
        await retryPlan
          .prepare(async (cmd, cmdArgs, cwd) => {
            await execProbe(cmd, [...cmdArgs], { cwd }, verifyCtx)
          }, stepCwd)
          .catch(() => {
            // best-effort: ignore repair failures; the retry decides the outcome
          })
      }

      const retryStart = performance.now()
      const retryResult = await runVerifyStep(
        spec.name,
        spec.gateId,
        spec.cmd,
        spec.args,
        stepCwd,
        verifyCtx,
        args.signal,
        stepTimeoutMs,
        args.onChildPid,
      )
      const retryDuration = Math.round(performance.now() - retryStart)
      if (retryResult.passed) {
        // Retry succeeded: the condition was transient. Record as passed.
        results.push({ ...retryResult, tier: 'task', duration: retryDuration })
        continue
      }
      // Retry also failed — let the heuristic rewrite the recorded output
      // (e.g. prepend a sentinel the failure classifier keys off). Returning
      // undefined records the retry verbatim.
      const rewritten = retryPlan.afterRetry?.(retryResult)
      results.push(
        rewritten
          ? {
              ...retryResult,
              tier: 'task',
              duration: retryDuration,
              stderr: rewritten.stderr,
              output: rewritten.output,
            }
          : { ...retryResult, tier: 'task', duration: retryDuration },
      )
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
    modelAttribution: args.modelAttribution,
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
