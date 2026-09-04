/**
 * Generic subprocess runner used by git helpers and install probes.
 *
 * `exec` and `execProbe` are the canonical subprocess utilities for the
 * orchestrator: every shell-out goes through `runTool` so each one emits a
 * `tool_invoked` trace event. `execProbe` is the non-throwing variant for
 * invocations whose entire API is the exit code (e.g. `git diff --quiet`).
 *
 * `TaskBranchAtRootError` guards against accidentally switching the integration
 * checkout HEAD to a task branch — both functions share the guard via the
 * private `assertNotTaskBranchAtRoot` helper.
 *
 * Previously these lived in `lib/git/internal`, which re-exports them for
 * back-compat. New callers should import directly from this module.
 */

import { getRepoRoot } from '../context'
import { runTool, nullTraceStore, type TraceCtx } from './run-tool'

interface ExecOpts {
  cwd: string
  timeoutMs?: number
  expectsFailure?: boolean
  tool?: string
  traceCtx?: TraceCtx
  /** Env overrides merged onto process.env for this invocation only. */
  env?: Record<string, string>
  /**
   * When aborted, the spawned child is SIGTERM'd then SIGKILL'd after a 2s
   * grace (see `runTool`). Forwarded verbatim to the underlying child process.
   */
  signal?: AbortSignal
  /**
   * Optional callback forwarded to `runTool` — invoked with the child's OS PID
   * immediately after spawn.
   */
  onPid?: (pid: number) => void
}

interface ExecError extends Error {
  code?: number
  stdout?: string
  stderr?: string
}

/**
 * Thrown when a `git checkout <task/*>` is attempted with `cwd` equal to
 * the repo root. The repo root is the integration checkout; switching its
 * HEAD to a task branch contaminates it for every in-flight merge.
 *
 * Observed 2026-08-05: HEAD at task/mars-fe86ca8f while the task had no DB
 * row, and a Worker had modified files INSIDE the integration checkout instead
 * of its worktree — causing `rescue/main-dirty-*` branches in the past and
 * blocking unrelated merges.
 *
 * Path-restore forms (`git checkout [<ref>] -- <path>`) do NOT move HEAD
 * and are exempt. Switching to non-task refs (e.g. `git checkout main`) is
 * also exempt — this guard only blocks the `task/*` namespace.
 */
export class TaskBranchAtRootError extends Error {
  constructor(args: readonly string[], cwd: string) {
    super(
      `[git-guard] refusing to switch the integration checkout to a task branch: ` +
        `git ${args.join(' ')} (cwd=${cwd}). ` +
        `Workers must operate in a dedicated worktree (.mars/worktrees/<id>/), ` +
        `not in the repo root.`,
    )
    this.name = 'TaskBranchAtRootError'
  }
}

/**
 * Guard: throw if about to switch the repo root HEAD to a `task/*` branch.
 *
 * Only `git checkout <task/branch>` is blocked. Path-restore forms
 * (`git checkout [<ref>] -- <path>`) include `--` as an argument separator
 * and are always allowed. Branch-creation forms (`git checkout -b task/foo`)
 * also target the `task/` namespace and are blocked: `createWorktree` uses
 * `git worktree add -b` instead, which carves a separate linked worktree and
 * does NOT move the root HEAD.
 *
 * Called from `runShell` so both `exec` and `execProbe` share the guard.
 */
const assertNotTaskBranchAtRoot = (args: readonly string[], cwd: string): void => {
  if (args[0] !== 'checkout') return
  // Path-restore: `git checkout [<ref>] -- <file>` — does NOT move HEAD.
  if (args.includes('--')) return
  // First non-flag operand is the branch/commit target.
  const target = args.slice(1).find((a) => !a.startsWith('-'))
  if (target === undefined || !target.startsWith('task/')) return
  if (cwd !== getRepoRoot()) return
  throw new TaskBranchAtRootError(args, cwd)
}

const runShell = async (
  cmd: string,
  args: readonly string[],
  opts: ExecOpts,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  assertNotTaskBranchAtRoot(args, opts.cwd)
  const ctx = opts.traceCtx
  const r = await runTool(
    {
      tool: opts.tool ?? cmd,
      argv: [...args],
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      taskId: ctx?.taskId ?? null,
      originId: ctx?.originId ?? null,
      phase: ctx?.phase ?? null,
      expectsFailure: opts.expectsFailure,
      signal: opts.signal,
      env: opts.env,
      onPid: opts.onPid,
    },
    ctx?.store ?? nullTraceStore,
  )
  if (r.exitCode !== 0 && opts.expectsFailure !== true) {
    const err = new Error(
      `${cmd} ${args.join(' ')} (cwd=${opts.cwd}) exited with code ${r.exitCode}: ${r.stderr.trim()}`,
    ) as ExecError
    err.code = r.exitCode
    err.stdout = r.stdout
    err.stderr = r.stderr
    throw err
  }
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

// Back-compat shim that mimics `promisify(execFile)`'s call shape so the
// migration is mechanical. The fourth argument carries the trace context.
export const exec = async (
  cmd: string,
  args: readonly string[],
  opts: {
    cwd: string
    timeout?: number
    maxBuffer?: number
    signal?: AbortSignal
    env?: Record<string, string>
  },
  traceCtx?: TraceCtx,
): Promise<{ stdout: string; stderr: string }> => {
  // `maxBuffer` is intentionally ignored — `runTool` caches the full output
  // in memory the same way `execFile` did; the truncation cap lives in the
  // trace payload, not the in-process buffer.
  void opts.maxBuffer
  return runShell(cmd, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeout,
    signal: opts.signal,
    env: opts.env,
    traceCtx,
  })
}

// Probe variant: returns the result with exitCode preserved instead of
// throwing on non-zero. Used by `git diff --quiet`, `git merge-base
// --is-ancestor`, and friends whose entire API is the exit code.
export const execProbe = async (
  cmd: string,
  args: readonly string[],
  opts: {
    cwd: string
    timeout?: number
    signal?: AbortSignal
    env?: Record<string, string>
    onPid?: (pid: number) => void
  },
  traceCtx?: TraceCtx,
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  runShell(cmd, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeout,
    signal: opts.signal,
    env: opts.env,
    onPid: opts.onPid,
    expectsFailure: true,
    traceCtx,
  })

export type { TraceCtx }
