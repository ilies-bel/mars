import { isAbsolute, join, dirname } from 'node:path'
import { access } from 'node:fs/promises'
import { statSync, constants as fsConstants, accessSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getRepoRoot } from '../../context'
import { runTool, nullTraceStore, type TraceCtx } from '../run-tool'

/**
 * Internal helper that funnels every git (or git-adjacent) shell-out through
 * `runTool` so each one emits a `tool_invoked` trace event. Mimics the
 * historical `promisify(execFile)` semantics: throws on non-zero exit unless
 * the caller marks it `expectsFailure` for probe-style invocations.
 *
 * Callers that legitimately read a non-zero exit (e.g. `git diff --quiet`,
 * `git merge-base --is-ancestor`) pass `expectsFailure: true` and inspect the
 * returned exitCode/error. The trace severity for probes is `info` (not warn)
 * so expected-failure probes don't pollute the warn/error channels.
 */
interface ExecOpts {
  cwd: string
  timeoutMs?: number
  expectsFailure?: boolean
  tool?: string
  traceCtx?: TraceCtx
  /** Env overrides merged onto process.env for this invocation only. Used by
   *  the checkpoint helpers for `GIT_INDEX_FILE` and the pinned commit identity. */
  env?: Record<string, string>
  /**
   * When aborted, the spawned child is SIGTERM'd then SIGKILL'd after a 2s
   * grace (see `runTool`). Forwarded verbatim to the underlying child process.
   */
  signal?: AbortSignal
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
  if (cwd !== repoRoot()) return
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
  opts: { cwd: string; timeout?: number; signal?: AbortSignal; env?: Record<string, string> },
  traceCtx?: TraceCtx,
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  runShell(cmd, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeout,
    signal: opts.signal,
    env: opts.env,
    expectsFailure: true,
    traceCtx,
  })

export type { TraceCtx }

// Hard timeout for git worktree list/prune calls. A corrupt .git/worktrees
// directory with many admin entries can make 'git worktree list --porcelain'
// and 'git worktree prune' hang indefinitely, which consumed every implement
// semaphore slot and stalled dispatch for hours (observed 2026-05-17 with
// ~353 corrupt entries). The timeout ensures these calls fail fast so
// createWorktree's .catch handlers can recover and dispatch proceeds.
// Override via MARS_WORKTREE_GIT_TIMEOUT_MS.
export const WORKTREE_GIT_TIMEOUT_MS = Number(
  process.env.MARS_WORKTREE_GIT_TIMEOUT_MS ?? 10_000,
)

export const repoRoot = (): string => getRepoRoot()
export const moduleDir = (): string => dirname(fileURLToPath(import.meta.url))

// Default search path for the `claude` binary when it is not on the daemon's
// PATH (e.g. detached / launchd contexts strip everything but a minimal PATH).
// Only consulted on POSIX — Windows users install claude.exe via the Windows
// installer which places it on PATH; there are no equivalent well-known
// fallback directories on Windows. Shared by both the claude- and git-binary
// resolvers.
export const FALLBACK_CLAUDE_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

export const isExecutableFile = (path: string): boolean => {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

// Portable filesystem-level existence check. Replaces a prior shell-out to
// `test -e <path>`, which is POSIX-only and would break on Windows where
// `/bin/test` does not exist. `fs.access(p, F_OK)` resolves when any
// directory entry (regular file, directory, symlink, fifo, socket, …)
// is present at `p`, and rejects on ENOENT / ENOTDIR, matching the
// semantics callers relied on for the previous `test -e` invocation.
// Exported for unit-testing on every host OS.
export const pathExists = async (p: string): Promise<boolean> => {
  if (typeof p !== 'string' || p.length === 0) return false
  try {
    await access(p, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

// Cache for the resolved git binary path. Keyed on process.env.PATH so
// tests can change PATH and get a fresh resolution without restarting the
// process. In production PATH is stable so the cache is effectively permanent.
let cachedGitBin: string | null = null
let cachedGitBinFor: string | undefined = undefined

/**
 * Resolve the absolute path to the `git` binary, caching the result.
 *
 * Searches PATH dirs then the POSIX fallback dirs (same set used for claude).
 * Throws `Error('git binary not found on PATH')` if git cannot be located.
 * Called once at daemon boot so that any PATH problem surfaces immediately
 * rather than as a per-task ENOENT mid-flight.
 */
export const resolveGitBin = (): string => {
  const envFingerprint = process.env.PATH ?? ''
  if (cachedGitBin !== null && cachedGitBinFor === envFingerprint) {
    return cachedGitBin
  }
  cachedGitBinFor = envFingerprint
  cachedGitBin = null

  const isWindows = process.platform === 'win32'
  const pathDelimiter = isWindows ? ';' : ':'
  const binaryNames = isWindows ? ['git.exe'] : ['git']
  // POSIX-only fallback directories — not applicable on Windows.
  const fallbackDirs = isWindows ? [] : FALLBACK_CLAUDE_PATH_DIRS

  const pathDirs = (process.env.PATH ?? '').split(pathDelimiter).filter((p) => p.length > 0)
  const seen = new Set<string>()
  for (const dir of [...pathDirs, ...fallbackDirs]) {
    if (seen.has(dir)) continue
    seen.add(dir)
    if (!isAbsolute(dir)) continue
    for (const name of binaryNames) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) {
        cachedGitBin = candidate
        return candidate
      }
    }
  }

  throw new Error('git binary not found on PATH')
}

interface RegisteredWorktree {
  path: string
  branch: string | null
}

export const listRegisteredWorktrees = async (
  traceCtx?: TraceCtx,
): Promise<RegisteredWorktree[]> => {
  const { stdout } = await exec(
    resolveGitBin(),
    ['worktree', 'list', '--porcelain'],
    {
      cwd: repoRoot(),
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    },
    traceCtx,
  )
  const entries: RegisteredWorktree[] = []
  let current: { path?: string; branch?: string | null } = {}
  const flush = (): void => {
    if (current.path) {
      entries.push({ path: current.path, branch: current.branch ?? null })
    }
    current = {}
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref
    } else if (line.startsWith('detached')) {
      current.branch = null
    } else if (line.length === 0) {
      flush()
    }
  }
  flush()
  return entries
}

export const branchExists = async (
  branch: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  // `git show-ref --verify --quiet` returns non-zero when the ref is missing.
  // That's a probe, not an error, so mark expectsFailure on the trace.
  const r = await execProbe(
    resolveGitBin(),
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: repoRoot() },
    traceCtx,
  )
  return r.exitCode === 0
}

export type { RegisteredWorktree }
