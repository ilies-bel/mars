import { spawn } from 'node:child_process'
import { resolve, dirname, isAbsolute, join } from 'node:path'
import { access, open, mkdir, readFile, rm, stat, unlink } from 'node:fs/promises'
import { statSync, constants as fsConstants, accessSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getRepoRoot, getStateDir } from '../context'
import { parseClaudeStreamLine, type ClaudeEvent } from './claude-stream'
import {
  runTool,
  nullTraceStore,
  type TraceCtx,
} from './run-tool'

/**
 * Internal helper that funnels every git (or git-adjacent) shell-out through
 * `runTool` so each one emits a `tool_invoked` trace event. Mimics the
 * historical `promisify(execFile)` semantics: throws on non-zero exit unless
 * the caller marks it `expectsFailure` for probe-style invocations.
 *
 * Callers that legitimately read a non-zero exit (e.g. `git diff --quiet`,
 * `git merge-base --is-ancestor`) pass `expectsFailure: true` and inspect the
 * returned exitCode/error. The trace severity follows the same rule
 * (info / warn / error) so the trace surface matches caller intent.
 */
interface ExecOpts {
  cwd: string
  timeoutMs?: number
  expectsFailure?: boolean
  tool?: string
  traceCtx?: TraceCtx
}

interface ExecError extends Error {
  code?: number
  stdout?: string
  stderr?: string
}

const runShell = async (
  cmd: string,
  args: readonly string[],
  opts: ExecOpts,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
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
const exec = async (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; timeout?: number; maxBuffer?: number },
  traceCtx?: TraceCtx,
): Promise<{ stdout: string; stderr: string }> => {
  // `maxBuffer` is intentionally ignored — `runTool` caches the full output
  // in memory the same way `execFile` did; the truncation cap lives in the
  // trace payload, not the in-process buffer.
  void opts.maxBuffer
  return runShell(cmd, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeout,
    traceCtx,
  })
}

// Probe variant: returns the result with exitCode preserved instead of
// throwing on non-zero. Used by `git diff --quiet`, `git merge-base
// --is-ancestor`, and friends whose entire API is the exit code.
const execProbe = async (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; timeout?: number },
  traceCtx?: TraceCtx,
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  runShell(cmd, args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeout,
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

const repoRoot = (): string => getRepoRoot()
const moduleDir = (): string => dirname(fileURLToPath(import.meta.url))

export interface CreateWorktreeArgs {
  taskId: string
  integrationBranch: string
  baseSha?: string
  branchSuffix?: string
  /** Optional trace context. When supplied, every git invocation issued by
   *  this call funnels through `runTool` with `phase: 'setup'`. */
  traceCtx?: TraceCtx
}

export interface WorktreeRef {
  path: string
  branch: string
}

interface RegisteredWorktree {
  path: string
  branch: string | null
}

const listRegisteredWorktrees = async (
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

const branchExists = async (
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

export const createWorktree = async ({
  taskId,
  integrationBranch,
  baseSha,
  branchSuffix,
  traceCtx,
}: CreateWorktreeArgs): Promise<WorktreeRef> => {
  const suffix = branchSuffix ? `-${branchSuffix}` : ''
  const branch = `task/${taskId}${suffix}`
  const dirName = `${taskId}${suffix}`
  const path = resolve(getStateDir(), `worktrees/${dirName}`)
  const startPoint = baseSha ?? integrationBranch
  const cwd = repoRoot()
  // Default phase to setup for createWorktree calls if the caller didn't pin
  // a phase explicitly. Most callers are workflows in the setup step.
  const setupCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'setup' }
    : undefined

  await mkdir(resolve(path, '..'), { recursive: true })

  // Prune any stale worktree registrations (paths recorded in .git/worktrees
  // that no longer exist on disk) before inspecting state. Both prune and
  // list are time-boxed: a corrupt .git/worktrees directory with many
  // entries can make these commands hang indefinitely, stalling every
  // implement dispatch until slots exhaust. Errors and timeouts fall through
  // to .catch below so createWorktree proceeds with an empty registration list.
  await execProbe(
    resolveGitBin(),
    ['worktree', 'prune'],
    { cwd, timeout: WORKTREE_GIT_TIMEOUT_MS },
    setupCtx,
  ).catch(() => {})

  const registered = await listRegisteredWorktrees(setupCtx).catch(
    () => [] as RegisteredWorktree[],
  )
  const existingForBranch = registered.find((w) => w.branch === branch)
  const existingForPath = registered.find((w) => w.path === path)

  // Already-registered worktree at the expected path on the expected branch:
  // reuse it as-is. This is the "skip if it already exists" path.
  if (
    existingForBranch &&
    existingForPath &&
    existingForBranch.path === existingForPath.path &&
    (await pathExists(path))
  ) {
    return { path, branch }
  }

  // Worktree registered at our path but on a different branch (or detached).
  // It's stale state from a previous run — drop it.
  if (existingForPath && existingForPath.branch !== branch) {
    await execProbe(
      resolveGitBin(),
      ['worktree', 'remove', '--force', existingForPath.path],
      { cwd },
      setupCtx,
    ).catch(() => {})
  }

  // Worktree registered for our branch at a different path. Drop that
  // registration so we can re-attach the branch at the canonical path.
  if (existingForBranch && existingForBranch.path !== path) {
    await execProbe(
      resolveGitBin(),
      ['worktree', 'remove', '--force', existingForBranch.path],
      { cwd },
      setupCtx,
    ).catch(() => {})
  }

  // Re-prune in case the removes above left dangling refs.
  await execProbe(
    resolveGitBin(),
    ['worktree', 'prune'],
    { cwd, timeout: WORKTREE_GIT_TIMEOUT_MS },
    setupCtx,
  ).catch(() => {})

  // If a directory still exists at our target path with no live worktree
  // registration, it's leftover filesystem state — wipe it.
  if (await pathExists(path)) {
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }

  const branchAlreadyExists = await branchExists(branch, setupCtx)
  const args = branchAlreadyExists
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, startPoint]
  await exec(resolveGitBin(), args, { cwd }, setupCtx)
  return { path, branch }
}

/**
 * Slice F.2 (main-commiter): provision a worktree the committer recovery
 * runs inside. The committer's whole purpose is to read the dirty state of
 * the integration branch and commit / stash it; the dirty state lives on
 * the repo's main checkout (`getRepoRoot()`), so a vanilla `createWorktree`
 * pointing at a `task/<id>` branch would land the committer in a CLEAN tree
 * — the wrong workspace.
 *
 * Approach: stash the dirty state in `repoRoot` (with `--include-untracked`),
 * spin up a fresh worktree at `.mars/worktrees/<recoveryTaskId>/` on a new
 * branch off `integrationBranch`, then pop the stash inside that worktree.
 * The result is that the recovery agent sees exactly the same `git status`
 * it would have seen in `repoRoot`, but in its own isolated working tree
 * (so concurrent task worktrees branched off main aren't affected by the
 * committer's edits until it commits on the integration branch via
 * `git -C <committerWorktree> commit` and the orchestrator later merges).
 *
 * If `git stash` produces no entry (e.g. only untracked-ignored files exist
 * which the stash refuses to capture), the worktree is still created on
 * the integration branch — the recipe re-checks `git status` at start and
 * exits successfully on a clean tree.
 */
export interface CommitterWorktreeArgs {
  /** Recovery task id used for path + branch naming. */
  recoveryTaskId: string
  integrationBranch: string
  traceCtx?: TraceCtx
}

export const provisionCommitterWorktree = async (
  args: CommitterWorktreeArgs,
): Promise<WorktreeRef> => {
  const cwd = repoRoot()
  const ctx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'setup' }
    : undefined

  // Stash the dirty state in the main checkout. `--include-untracked` covers
  // untracked-but-not-ignored files so the committer sees the full picture.
  // `git stash push` returns non-zero when there is nothing to stash; treat
  // that as a benign skip so a stale-detection race (state cleaned between
  // our probe and this call) doesn't hard-fail the recovery spawn.
  const stashMessage = `mars main-commiter spawn ${args.recoveryTaskId}`
  const stashed = await execProbe(
    resolveGitBin(),
    ['stash', 'push', '--include-untracked', '-m', stashMessage],
    { cwd },
    ctx,
  )
  // Standard git output: "No local changes to save" means we have nothing
  // to migrate; stick with the clean integration branch and let the
  // recipe re-check.
  const haveStash =
    stashed.exitCode === 0 && !/No local changes to save/i.test(stashed.stdout)

  // Build the worktree on a fresh branch off the integration tip via the
  // standard `createWorktree`. The branch is `task/<recoveryTaskId>` and
  // lives under `.mars/worktrees/<recoveryTaskId>/` — same conventions
  // as a normal Coder worktree so cleanup (`removeWorktree`) is uniform.
  const worktree = await createWorktree({
    taskId: args.recoveryTaskId,
    integrationBranch: args.integrationBranch,
    traceCtx: ctx,
  })

  if (haveStash) {
    // Pop the stash into the new worktree. `stash pop` on conflicts is a
    // recoverable state for the agent (it sees the conflicted files in
    // `git status`); we surface the exit code as a probe rather than
    // throwing, so the recipe can decide what to do.
    await execProbe(resolveGitBin(), ['stash', 'pop'], { cwd: worktree.path }, ctx)
  }

  return worktree
}

export const resolveSha = async (
  ref: string,
  traceCtx?: TraceCtx,
): Promise<string> => {
  const { stdout } = await exec(
    resolveGitBin(),
    ['rev-parse', ref],
    { cwd: repoRoot() },
    traceCtx,
  )
  return stdout.trim()
}

export const removeWorktree = async (
  ref: WorktreeRef,
  force = true,
  keepBranch = false,
  traceCtx?: TraceCtx,
): Promise<void> => {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(ref.path)
  await exec(resolveGitBin(), args, { cwd: repoRoot() }, traceCtx)
  if (!keepBranch) {
    await execProbe(
      resolveGitBin(),
      ['branch', '-D', ref.branch],
      { cwd: repoRoot() },
      traceCtx,
    ).catch(() => {})
  }
}

export interface RunSubprocessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SubprocessLine {
  stream: 'stdout' | 'stderr'
  line: string
}

// Live PIDs for every subprocess spawned through this module. Used by
// `mars daemon kill` to terminate every child claude -p (and any git/verify
// subprocess) when foreground-mode pgid signalling isn't safe. Entries are
// added at spawn time and removed on 'close'/'error'.
const liveChildPids = new Set<number>()

export const getLiveChildPids = (): readonly number[] => Array.from(liveChildPids)

// SIGKILL every tracked child. Best-effort: a PID that has already exited or
// that the process lacks permission to signal is silently skipped. Returns
// the list of PIDs we attempted to kill.
export const killAllChildren = (): readonly number[] => {
  const killed: number[] = []
  for (const pid of liveChildPids) {
    try {
      process.kill(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // child already gone or unsignalable
    }
  }
  return killed
}

export const runSubprocessStreaming = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  onLine?: (event: SubprocessLine) => void | Promise<void>,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<RunSubprocessResult> =>
  new Promise((resolveFn) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (typeof child.pid === 'number') liveChildPids.add(child.pid)
    let stdout = ''
    let stderr = ''
    const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }

    const handleChunk = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString()
      if (stream === 'stdout') stdout += text
      else stderr += text
      if (!onLine) return
      buffers[stream] += text
      let newlineIndex = buffers[stream].indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffers[stream].slice(0, newlineIndex).replace(/\r$/, '')
        buffers[stream] = buffers[stream].slice(newlineIndex + 1)
        try {
          void onLine({ stream, line })
        } catch {
          // Swallow handler errors — they must not abort the subprocess capture.
        }
        newlineIndex = buffers[stream].indexOf('\n')
      }
    }

    const onAbort = () => {
      if (!child.killed) child.kill('SIGKILL')
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk) => handleChunk('stdout', chunk))
    child.stderr?.on('data', (chunk) => handleChunk('stderr', chunk))
    let settled = false
    const settle = (result: RunSubprocessResult): void => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      resolveFn(result)
    }
    // A spawn failure (e.g. ENOENT for a missing binary, EACCES) emits
    // 'error' on the ChildProcess and never fires 'close'. Without this
    // listener Node treats it as an unhandled 'error' event and crashes
    // the entire daemon process.
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (typeof child.pid === 'number') liveChildPids.delete(child.pid)
      const detail = err.code ? `${err.code}: ${err.message}` : err.message
      settle({
        exitCode: err.code === 'ENOENT' ? 127 : 1,
        stdout,
        stderr: stderr + (stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n') + `spawn ${cmd} ${detail}`,
      })
    })
    child.on('close', (code) => {
      if (typeof child.pid === 'number') liveChildPids.delete(child.pid)
      if (onLine) {
        for (const stream of ['stdout', 'stderr'] as const) {
          if (buffers[stream].length > 0) {
            const line = buffers[stream].replace(/\r$/, '')
            buffers[stream] = ''
            try {
              void onLine({ stream, line })
            } catch {
              // Swallow handler errors — final flush must not throw.
            }
          }
        }
      }
      settle({ exitCode: code ?? 1, stdout, stderr })
    })
  })

export const runSubprocess = (
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<RunSubprocessResult> => runSubprocessStreaming(cmd, args, cwd)

export interface RunClaudeArgs {
  cwd: string
  prompt: string
  /**
   * Wall-clock timeout in milliseconds. If omitted or ≤ 0, no timeout is
   * armed and the subprocess runs to completion (or until Ctrl-C).
   */
  timeoutMs?: number
  model?: string
  systemPrompt?: string
  sessionId?: string
  onEvent?: (event: ClaudeEvent) => void | Promise<void>
  // Per-Worker pinned config (claude -p flags). All optional; the wrapper
  // applies them on top of the existing argv. Agent-to-user denials always
  // remain in --disallowedTools regardless of caller-supplied disallowedTools.
  effort?: ClaudeEffort
  permissionMode?: ClaudePermissionMode
  bare?: boolean
  agent?: string
  disallowedTools?: ReadonlyArray<string>
  // Per-invocation override for the message cap enforced inside runClaudeCode.
  // When omitted, defaults to DEFAULT_CLAUDE_MAX_MESSAGES (0 = unbounded).
  maxMessages?: number
  /**
   * Optional caller-supplied abort signal. When fired, runClaudeCode
   * SIGKILLs the child and returns a `exitCode: 137` result. Used by the
   * read/grep span watcher to terminate sessions that have stalled on
   * reads. The signal is ORed with the internal timeout + message-cap
   * abort, so either side can trigger termination.
   */
  externalAbort?: AbortSignal
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ClaudePermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan'

export interface RunClaudeResult extends RunSubprocessResult {
  sessionId: string | null
  conversation: ClaudeEvent[]
}

const extractSessionIdFromConversation = (
  conversation: ClaudeEvent[],
): string | null => {
  for (const event of conversation) {
    const sid = (event as { session_id?: unknown }).session_id
    if (typeof sid === 'string' && sid.length > 0) return sid
  }
  return null
}

const extractSessionId = (stdout: string): string | null => {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const match = trimmed.match(/"session_id"\s*:\s*"([^"]+)"/)
  return match?.[1] ?? null
}

interface ClaudeStreamArgsOptions {
  model?: string
  systemPrompt?: string
  sessionId?: string
  effort?: ClaudeEffort
  permissionMode?: ClaudePermissionMode
  bare?: boolean
  agent?: string
  // Caller-supplied disallowed tools. Unioned with AGENT_TO_USER_DENIED_TOOLS;
  // duplicates collapse. The agent-to-user denial cannot be removed by a caller.
  disallowedTools?: ReadonlyArray<string>
}

// Agent-to-user tools denied for every dispatched Session. No human is
// listening on a dispatched run, so a call to either tool errors at the
// claude runtime and tempts the agent to silently drift from the task.
// Denying them at the single shared wrapper means every workflow — including
// any path that bypasses the Worker primitive and calls the wrapper directly
// — inherits the ban. See idea 948691d0.
const AGENT_TO_USER_DENIED_TOOLS = ['AskUserQuestion', 'SendUserMessage'] as const

// Default search-tool guidance injected into every dispatched worker's system
// prompt. The host previously enforced this via PreToolUse rewriter hooks on
// the user's Claude settings; centralising it here keeps the constraint with
// the orchestrator and propagates to every workflow path.
export const SEARCH_TOOL_SYSTEM_PROMPT =
  'Use `rg` (ripgrep) instead of `grep`/`egrep`/`fgrep`, and `fd` instead of `find`. Both are installed; they are faster, respect .gitignore by default, and have saner defaults.'

const composeSystemPrompt = (caller?: string): string => {
  const trimmed = caller?.trim()
  if (!trimmed) return SEARCH_TOOL_SYSTEM_PROMPT
  return `${SEARCH_TOOL_SYSTEM_PROMPT}\n\n${trimmed}`
}

// Resolve the permission flag(s). Callers that pin a non-bypass mode (e.g. the
// Planner/Slicer/Triager Workers) get `--permission-mode <mode>` instead of
// `--dangerously-skip-permissions`, so a read-only Worker cannot escalate.
// The default (no caller pin) preserves the historical behaviour of running
// dispatched workers under `--dangerously-skip-permissions` inside a fresh
// worktree.
const permissionFlags = (mode: ClaudePermissionMode | undefined): readonly string[] => {
  if (mode === undefined || mode === 'bypassPermissions') {
    return ['--dangerously-skip-permissions']
  }
  return ['--permission-mode', mode]
}

const mergeDisallowedTools = (
  callerDisallowed: ReadonlyArray<string> | undefined,
): string => {
  const merged = new Set<string>(AGENT_TO_USER_DENIED_TOOLS)
  for (const tool of callerDisallowed ?? []) {
    const trimmed = tool.trim()
    if (trimmed.length === 0) continue
    merged.add(trimmed)
  }
  return [...merged].join(',')
}

export const claudeStreamArgs = (
  prompt: string,
  options: ClaudeStreamArgsOptions = {},
): readonly string[] => [
  '-p',
  prompt,
  '--output-format',
  'stream-json',
  '--verbose',
  ...permissionFlags(options.permissionMode),
  '--strict-mcp-config',
  '--setting-sources',
  'project,local',
  '--no-session-persistence',
  '--exclude-dynamic-system-prompt-sections',
  ...(options.bare ? ['--bare'] : []),
  ...(options.agent ? ['--agent', options.agent] : []),
  ...(options.effort ? ['--effort', options.effort] : []),
  '--disallowedTools',
  mergeDisallowedTools(options.disallowedTools),
  ...(options.model ? ['--model', options.model] : []),
  '--system-prompt',
  composeSystemPrompt(options.systemPrompt),
  ...(options.sessionId ? ['--session-id', options.sessionId] : []),
  // No --max-turns: the Claude Code CLI runs unbounded turns. The 60-turn cap
  // was cutting Coders off mid-implementation (they spend 30+ turns exploring
  // before they edit/commit), producing spurious verify:has-diff/no-commits
  // failures.
]

// 0 = no message cap (unbounded). runClaudeCode treats cap<=0 as "capEnabled
// = false" and never aborts on message count. A Worker that needs a hard
// ceiling sets one explicitly (e.g. Triager=40); everything else runs to
// natural completion. The 100 default was cutting Coders off mid-implementation.
const DEFAULT_CLAUDE_MAX_MESSAGES = 0

// Default search path for the `claude` binary when it is not on the daemon's
// PATH (e.g. detached / launchd contexts strip everything but a minimal PATH).
// Only consulted on POSIX — Windows users install claude.exe via the Windows
// installer which places it on PATH; there are no equivalent well-known
// fallback directories on Windows.
const FALLBACK_CLAUDE_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

const isExecutableFile = (path: string): boolean => {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

// Strip the host claude session's identity vars so a daemon launched from
// inside an interactive `claude` shell cannot contaminate dispatched workers.
export const buildWorkerEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^CLAUDE(CODE)?($|_)/i.test(key)) delete env[key]
  }
  return env
}

let cachedClaudeBin: string | null = null
let cachedClaudeBinFor: string | undefined = undefined

// Build a cache key from MARS_CLAUDE_BIN + PATH. The separator must be a
// single character that cannot legitimately appear inside either env var.
// We avoid U+0000 (NUL) on purpose: a literal NUL in the compiled template
// literal makes ripgrep classify this file as binary and refuse to print
// matches ("binary file matches"), forcing agents grepping git.ts into
// awk + multi-Read fallbacks. U+0001 (SOH) is just as unusable inside a
// real binary path or PATH entry, but ripgrep treats it as text.
export const claudeBinEnvFingerprint = (
  override: string | undefined,
  path: string | undefined,
): string => `${override ?? ''}${path ?? ''}`

export const resolveClaudeBin = (): string => {
  const override = process.env.MARS_CLAUDE_BIN
  // Re-resolve when the relevant env changes (mostly for tests; in prod it
  // is set once at daemon start and never mutates).
  const envFingerprint = claudeBinEnvFingerprint(override, process.env.PATH)
  if (cachedClaudeBin && cachedClaudeBinFor === envFingerprint) {
    return cachedClaudeBin
  }
  cachedClaudeBinFor = envFingerprint

  if (override && override.length > 0) {
    cachedClaudeBin = override
    return override
  }

  // Use the platform-appropriate PATH delimiter at call time so that the
  // resolver works correctly on both POSIX (':') and Windows (';').
  const isWindows = process.platform === 'win32'
  const pathDelimiter = isWindows ? ';' : ':'
  // On Windows probe for .exe and .cmd; on POSIX probe for the plain name.
  const binaryNames = isWindows ? ['claude.exe', 'claude.cmd'] : ['claude']
  // POSIX-only fallback directories — not applicable on Windows where
  // the installer places claude.exe on PATH.
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
        cachedClaudeBin = candidate
        return candidate
      }
    }
  }

  // Fall back to the bare name; spawn will surface ENOENT cleanly thanks to
  // the 'error' handler in runSubprocessStreaming.
  cachedClaudeBin = 'claude'
  return 'claude'
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

const resolveClaudeMessageCap = (override?: number): number => {
  if (override !== undefined && Number.isInteger(override) && override >= 0) {
    return override
  }
  return DEFAULT_CLAUDE_MAX_MESSAGES
}

export const runClaudeCode = async ({
  cwd,
  prompt,
  timeoutMs,
  model,
  systemPrompt,
  sessionId,
  onEvent,
  effort,
  permissionMode,
  bare,
  agent,
  disallowedTools,
  maxMessages,
  externalAbort,
}: RunClaudeArgs): Promise<RunClaudeResult> => {
  const conversation: ClaudeEvent[] = []
  const cap = resolveClaudeMessageCap(maxMessages)
  const capEnabled = cap > 0
  const warnAt = capEnabled ? Math.floor(cap * 0.6) : Number.POSITIVE_INFINITY
  let warned = false
  let capHit = false
  let externalAborted = false
  const abort = new AbortController()
  // Bridge a caller-supplied AbortSignal onto the internal controller so a
  // single SIGKILL path covers timeout, cap, and external (read/grep span)
  // abort causes.
  if (externalAbort) {
    if (externalAbort.aborted) {
      externalAborted = true
      abort.abort()
    } else {
      externalAbort.addEventListener(
        'abort',
        () => {
          externalAborted = true
          abort.abort()
        },
        { once: true },
      )
    }
  }

  // Track whether the wall-clock timeout fired so we can synthesise the
  // 124/"timed out" result after the subprocess has actually died. We MUST
  // await the underlying `work` promise before returning — racing it against
  // a setTimeout that only resolves a sibling promise (the previous design)
  // leaks the live Claude child: the workflow proceeds to `verifyChanges`
  // while Claude keeps writing files and running `git commit`, producing a
  // ghost `verify:has-diff/no-commits-ahead` failure whose worktree later
  // shows a commit that "should have passed". Aborting via the same
  // AbortController used for the message cap funnels both kill paths
  // through `runSubprocessStreaming`'s SIGKILL + drain semantics.
  let timedOut = false
  // Only arm the wall-clock timeout when the caller supplies a positive value.
  // Omitting timeoutMs (or passing ≤ 0) means the subprocess runs to
  // completion — the reflect synthesis path uses this to avoid killing a slow
  // Claude generation mid-flight. The message-cap (exit 137) path below is
  // independent and always active when a maxMessages cap is set.
  const timeoutHandle =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          abort.abort()
        }, timeoutMs)
      : undefined
  const result = await runSubprocessStreaming(
    resolveClaudeBin(),
    claudeStreamArgs(prompt, {
      model,
      systemPrompt,
      sessionId,
      effort,
      permissionMode,
      bare,
      agent,
      disallowedTools,
    }),
    cwd,
    async ({ stream, line }) => {
      if (stream !== 'stdout') return
      const event = parseClaudeStreamLine(line)
      if (!event) return
      // Once the cap has fired, drop any late-arriving events still buffered
      // from the child between abort() and process death. The conversation
      // length must equal exactly `cap` for cap-hit runs.
      if (capHit) return
      conversation.push(event)
      if (onEvent) await onEvent(event)
      if (!capEnabled) return
      if (!warned && conversation.length === warnAt) {
        warned = true
        const sid =
          extractSessionIdFromConversation(conversation) ?? sessionId ?? '?'
        console.warn(
          `[mars] claude session ${sid} crossed ${warnAt} messages (cap ${cap})`,
        )
      }
      if (conversation.length >= cap) {
        capHit = true
        abort.abort()
      }
    },
    abort.signal,
    buildWorkerEnv(),
  )
  clearTimeout(timeoutHandle)
  const detectedSessionId =
    extractSessionIdFromConversation(conversation) ??
    extractSessionId(result.stdout) ??
    sessionId ??
    null
  if (capHit) {
    return {
      exitCode: 137,
      stdout: result.stdout,
      stderr: `claude -p hit message cap of ${cap}`,
      sessionId: detectedSessionId,
      conversation,
    }
  }
  if (timedOut) {
    return {
      exitCode: 124,
      stdout: result.stdout,
      stderr: `claude -p timed out after ${timeoutMs}ms`,
      sessionId: detectedSessionId,
      conversation,
    }
  }
  if (externalAborted) {
    return {
      exitCode: 138,
      stdout: result.stdout,
      stderr: `claude -p aborted by caller (read/grep span watcher)`,
      sessionId: detectedSessionId,
      conversation,
    }
  }
  return { ...result, sessionId: detectedSessionId, conversation }
}

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
   *  `expectsFailure: true` so the trace severity stays warn instead of
   *  flagging every failing verify run as a hard error. */
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
// Surfaced in the failure output so post-mortems and inbox investigators
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
        output: `has-diff: worktree path ${cwdMissingMatch[1]} no longer exists`,
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
    if (stoppedOnRequired && spec.required) continue
    // Each step runs in its own scope directory rather than from one
    // flattened working directory: the root scope ('.' or unset) runs in
    // the verify root; a narrower scope runs in its subdirectory.
    const stepCwd =
      spec.dir && spec.dir !== '.' ? resolve(args.cwd, spec.dir) : args.cwd
    const result = await runVerifyStep(
      spec.name,
      spec.cmd,
      spec.args,
      stepCwd,
      verifyCtx,
    )
    results.push(result)
    if (!result.passed && spec.required) {
      stoppedOnRequired = true
    }
  }

  const requiredFailed = args.steps.some((spec, i) => {
    const r = results[i]
    return spec.required && r && !r.passed
  })
  return { passed: !requiredFailed && !stoppedOnRequired, steps: results }
}

const DEFAULT_VERIFY_STEPS: VerifyStepSpec[] = [
  { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
  { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
  { name: 'lint', cmd: 'npx', args: ['biome', 'check', '.'], required: true },
]

interface ManifestSupervisorEntry {
  name?: string
  scope?: string
  verify?: ReadonlyArray<{
    name: string
    cmd: string
    args: readonly string[]
    required?: boolean
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

const rootScopeOnly = (): VerifyScope[] => [
  { scope: '.', steps: DEFAULT_VERIFY_STEPS.map((s) => ({ ...s, dir: '.' })) },
]

/**
 * Load the recipe's verify steps grouped by scope. Unlike the previous
 * collapse-by-name behaviour, two scopes that declare a step with the
 * same name are kept as distinct entries — each scope owns its steps and
 * its directory. Within a single scope a repeated step name keeps the
 * first occurrence. A missing, unparseable, or verify-less manifest
 * degrades to a single root scope running the default steps.
 */
export const loadVerifyScopes = async (
  manifestPath: string,
): Promise<VerifyScope[]> => {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return rootScopeOnly()
    }
    throw error
  }
  let parsed: SupervisorsManifest
  try {
    parsed = JSON.parse(raw) as SupervisorsManifest
  } catch {
    return rootScopeOnly()
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
      steps.set(v.name, {
        name: v.name,
        cmd: v.cmd,
        args: [...v.args],
        required: v.required ?? true,
        dir: scope,
      })
    }
  }
  if (byScope.size === 0) return rootScopeOnly()
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

export const DEFAULT_VERIFY_STEPS_FALLBACK: ReadonlyArray<VerifyStepSpec> =
  DEFAULT_VERIFY_STEPS

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM means the process exists but we don't have permission to signal it.
    if (code === 'EPERM') return true
    return false
  }
}

const isLockStale = async (lockPath: string): Promise<boolean> => {
  try {
    const contents = (await readFile(lockPath, 'utf8')).trim()
    if (!contents) return true
    const pid = Number.parseInt(contents, 10)
    if (!Number.isInteger(pid) || pid <= 0) return true
    if (pid === process.pid) return true
    return !isPidAlive(pid)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // The lock vanished between our failed open and the read — treat as stale
    // so the next open attempt can claim it.
    if (code === 'ENOENT') return true
    return false
  }
}

export const acquireLock = async (
  lockPath: string,
  timeoutMs: number,
): Promise<() => Promise<void>> => {
  await mkdir(resolve(lockPath, '..'), { recursive: true })
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.write(String(process.pid))
      return async () => {
        await handle.close()
        await unlink(lockPath).catch(() => {})
      }
    } catch {
      // If the existing lock's owner is dead (or the file is empty/corrupt),
      // reclaim it. The retry loop handles TOCTOU: if another process beats
      // us to unlink+open, our next `open(..., 'wx')` simply fails and we
      // fall back to polling.
      if (await isLockStale(lockPath)) {
        await unlink(lockPath).catch(() => {})
        continue
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error(`Failed to acquire merge lock after ${timeoutMs}ms`)
}

export type MergeTargetStatus =
  | { kind: 'clean' }
  // The task branch has diverged from / fallen behind integration, so a
  // bare `--ff-only` would fail. This is NOT a blocking failure: mergeBranch
  // Step 1 rebases the task branch onto integration (escalating to the
  // vcs-supervisor on conflict) before the ff. Preflight must let these
  // through, not park the task — conflating this with `dirty` is what made
  // every lapped branch dead-loop the retry budget.
  | { kind: 'needs-rebase'; targetPath: string; statusOutput: string }
  | { kind: 'dirty'; targetPath: string; statusOutput: string }
  | { kind: 'error'; error: Error }

export interface CheckMergeTargetArgs {
  integrationBranch: string
  taskBranch: string
  /** Optional trace context. Default phase is `merge` when omitted. */
  traceCtx?: TraceCtx
}

// Classifies the merge target ahead of mergeBranch:
//   - 'error'        : a ref does not resolve / git failed unexpectedly.
//   - 'needs-rebase' : integrationBranch is NOT an ancestor of taskBranch
//                      (diverged or behind). Recoverable — mergeBranch
//                      Step 1 rebases before the ff. Preflight proceeds.
//   - 'dirty'        : a tracked, uncommitted change in the merge target
//                      sits on a path the ff would update. Blocking.
//   - 'clean'        : ff is feasible and the target is pristine.
// Untracked files are deliberately ignored: an untracked .idea/ or editor
// scratch file in the merge target cannot block `git merge --ff-only`.
export const checkMergeTargetStatus = async (
  args: CheckMergeTargetArgs,
): Promise<MergeTargetStatus> => {
  const targetPath = repoRoot()
  const { integrationBranch, taskBranch } = args
  const mergeCtx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'merge' }
    : undefined
  try {
    await exec(
      resolveGitBin(),
      ['rev-parse', '--verify', `${integrationBranch}^{commit}`],
      { cwd: targetPath },
      mergeCtx,
    )
    await exec(
      resolveGitBin(),
      ['rev-parse', '--verify', `${taskBranch}^{commit}`],
      { cwd: targetPath },
      mergeCtx,
    )

    // `git merge-base --is-ancestor` exits 0 when ancestor, 1 when not, other
    // codes on usage/IO errors. Use execProbe so non-zero exits are warn-level
    // probes in the trace rather than spurious errors.
    const ancestry = await execProbe(
      resolveGitBin(),
      ['merge-base', '--is-ancestor', integrationBranch, taskBranch],
      { cwd: targetPath },
      mergeCtx,
    )
    if (ancestry.exitCode !== 0) {
      if (ancestry.exitCode === 1) {
        // Diverged or behind: a rebase candidate, NOT a dirty-target failure.
        // mergeBranch Step 1 rebases onto integration before the ff merge.
        return {
          kind: 'needs-rebase',
          targetPath,
          statusOutput: `task branch ${taskBranch} is not a fast-forward of ${integrationBranch} (diverged or behind)`,
        }
      }
      return {
        kind: 'error',
        error: new Error(
          `git merge-base --is-ancestor failed (code=${ancestry.exitCode}): ${ancestry.stderr.trim()}`,
        ),
      }
    }

    const diff = await exec(
      resolveGitBin(),
      ['diff', '--name-only', `${integrationBranch}..${taskBranch}`],
      { cwd: targetPath },
      mergeCtx,
    )
    const changedPaths = diff.stdout.split('\n').filter((p) => p.length > 0)
    if (changedPaths.length === 0) return { kind: 'clean' }

    // Cap pathspec argv to avoid blowing past ARG_MAX on huge diffs; if we
    // exceed it, fall back to a tracked-only global status. Untracked files
    // are still ignored — they cannot block an ff.
    const PATH_CAP = 500
    const statusArgs = ['status', '--porcelain', '--untracked-files=no']
    if (changedPaths.length <= PATH_CAP) {
      statusArgs.push('--', ...changedPaths)
    }
    const status = await exec(
      resolveGitBin(),
      statusArgs,
      { cwd: targetPath },
      mergeCtx,
    )
    if (status.stdout.length === 0) return { kind: 'clean' }
    return {
      kind: 'dirty',
      targetPath,
      statusOutput: `tracked changes on paths the fast-forward would update:\n${status.stdout}`,
    }
    // TODO(merge_target_missing): also surface a 'missing' kind when the
    // merge target branch has been deleted/renamed; for now any unexpected
    // git failure is reported as 'error'.
  } catch (error: unknown) {
    return {
      kind: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export interface MergeArgs {
  branch: string
  worktreePath: string
  integrationBranch: string
  lockTimeoutMs: number
  /** Optional trace context. Default phase is `merge` when omitted. */
  traceCtx?: TraceCtx
  onSupervisorEvent?: (event: ClaudeEvent) => void | Promise<void>
  /**
   * Fired exactly once, the moment the deterministic fast-forward path fails
   * and Vega (the vcs-supervisor) is about to be spawned to reconcile
   * conflicts. A clean fast-forward never invokes this. Callers use it to flip
   * the task from the idempotent `merging` status to `vega-reconciling`, so the
   * operator can tell a safe-to-resume merge apart from one hosting a live
   * Claude session.
   */
  onVegaStart?: () => void | Promise<void>
}

export interface MergeResult {
  merged: boolean
  conflictResolved: boolean
  aborted: boolean
  output: string
  supervisorConversation: ClaudeEvent[]
}

let cachedSupervisorSpec: string | null = null

export const stripFrontmatter = (text: string): string => {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return text
  const afterOpening = text.indexOf('\n') + 1
  const closingMatch = text.slice(afterOpening).match(/^---(\r?\n|$)/m)
  if (!closingMatch || closingMatch.index === undefined) return text
  const closingEnd = afterOpening + closingMatch.index + closingMatch[0].length
  return text.slice(closingEnd).replace(/^\r?\n+/, '')
}

const loadSupervisorSpec = async (): Promise<string> => {
  if (cachedSupervisorSpec) return cachedSupervisorSpec
  const candidates = [
    resolve(moduleDir(), '../public/prompts/vcs-supervisor.md'),
    resolve(moduleDir(), './prompts/vcs-supervisor.md'),
  ]
  for (const candidate of candidates) {
    try {
      cachedSupervisorSpec = await readFile(candidate, 'utf8')
      return cachedSupervisorSpec
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(
    `vcs-supervisor.md not found; checked: ${candidates.join(', ')}`,
  )
}

const buildSupervisorPrompt = async (
  branch: string,
  integrationBranch: string,
): Promise<string> => {
  const spec = stripFrontmatter(await loadSupervisorSpec())
  return `${spec}

# Dispatch

Mode: rebase
Source: ${branch}
Target: ${integrationBranch}

A \`git rebase ${integrationBranch}\` of ${branch} just conflicted in this worktree. The rebase is in progress (\`.git/rebase-merge/\` or \`.git/rebase-apply/\` exists). Your cwd IS the worktree — do not \`cd\` elsewhere.

Resolve every conflict per your protocol — read both sides, reconcile intent, never blindly pick ours/theirs. After staging each step, use \`git rebase --continue\` (NOT \`git commit\`). Repeat until the rebase finishes.

End with the Completion Report block exactly as specified above.`
}

interface InvokeSupervisorResult extends RunSubprocessResult {
  conversation: ClaudeEvent[]
}

const invokeVcsSupervisor = async (
  branch: string,
  integrationBranch: string,
  cwd: string,
  timeoutMs: number,
  onEvent?: (event: ClaudeEvent) => void | Promise<void>,
): Promise<InvokeSupervisorResult> => {
  const prompt = await buildSupervisorPrompt(branch, integrationBranch)
  const conversation: ClaudeEvent[] = []
  const work = runSubprocessStreaming(
    resolveClaudeBin(),
    claudeStreamArgs(prompt),
    cwd,
    async ({ stream, line }) => {
      if (stream !== 'stdout') return
      const event = parseClaudeStreamLine(line)
      if (!event) return
      conversation.push(event)
      if (onEvent) await onEvent(event)
    },
    undefined,
    buildWorkerEnv(),
  )
  const timeout = new Promise<RunSubprocessResult>((resolveFn) =>
    setTimeout(
      () =>
        resolveFn({
          exitCode: 124,
          stdout: '',
          stderr: `vcs-supervisor timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    ),
  )
  const result = await Promise.race([work, timeout])
  return { ...result, conversation }
}

// Portable directory check. Replaces a prior shell-out to `test -d <path>`,
// which is POSIX-only. `fs.stat(p).isDirectory()` works identically across
// darwin/linux/windows and returns false (rather than throwing) when the
// path is missing.
const isDirectory = async (p: string): Promise<boolean> => {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

const isRebaseInProgress = async (
  cwd: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['rev-parse', '--git-path', 'rebase-merge'],
      { cwd },
      traceCtx,
    )
    const mergePath = stdout.trim()
    const { stdout: applyStdout } = await exec(
      resolveGitBin(),
      ['rev-parse', '--git-path', 'rebase-apply'],
      { cwd },
      traceCtx,
    )
    const applyPath = applyStdout.trim()
    const checks = await Promise.all([
      isDirectory(mergePath),
      isDirectory(applyPath),
    ])
    return checks.some(Boolean)
  } catch {
    return false
  }
}

export const mergeBranch = async ({
  branch,
  worktreePath,
  integrationBranch,
  lockTimeoutMs,
  onSupervisorEvent,
  onVegaStart,
  traceCtx,
}: MergeArgs): Promise<MergeResult> => {
  const mergeCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'merge' }
    : undefined
  const release = await acquireLock(
    resolve(getStateDir(), '.merge.lock'),
    lockTimeoutMs,
  )
  try {
    let output = ''
    let conflictResolved = false
    const supervisorConversation: ClaudeEvent[] = []

    // Step 1: ensure the task branch is up-to-date with integration via rebase
    // inside the worktree. After this, integration can fast-forward to it.
    // The rebase is allowed to fail (conflict path); execProbe keeps the
    // trace severity at warn instead of error for the expected-failure path.
    const rebaseResult = await execProbe(
      resolveGitBin(),
      ['rebase', integrationBranch],
      { cwd: worktreePath },
      mergeCtx,
    )
    output += rebaseResult.stdout + rebaseResult.stderr
    if (rebaseResult.exitCode !== 0) {
      // Deterministic fast-forward has failed: we are about to hand the
      // conflict to a live Vega (Claude) session. Signal the transition out of
      // the idempotent `merging` phase before spawning, so the task shows as
      // `vega-reconciling` for the full duration of the session.
      await onVegaStart?.()

      const preSha = (
        await exec(resolveGitBin(), ['rev-parse', branch], { cwd: repoRoot() }, mergeCtx)
      ).stdout.trim()

      const supervisorTimeoutMs = 30 * 60 * 1000
      const sup = await invokeVcsSupervisor(
        branch,
        integrationBranch,
        worktreePath,
        supervisorTimeoutMs,
        onSupervisorEvent,
      )
      supervisorConversation.push(...sup.conversation)
      output += sup.stdout + sup.stderr

      const stillInProgress = await isRebaseInProgress(worktreePath, mergeCtx)
      const postSha = (
        await exec(resolveGitBin(), ['rev-parse', branch], { cwd: repoRoot() }, mergeCtx)
      ).stdout.trim()
      const advanced = postSha !== preSha
      const treeClean = await (async () => {
        // `git diff --quiet` is a probe: exit 0 = clean, exit 1 = dirty.
        const a = await execProbe(
          resolveGitBin(),
          ['diff', '--quiet'],
          { cwd: worktreePath },
          mergeCtx,
        )
        if (a.exitCode !== 0) return false
        const b = await execProbe(
          resolveGitBin(),
          ['diff', '--cached', '--quiet'],
          { cwd: worktreePath },
          mergeCtx,
        )
        return b.exitCode === 0
      })()

      if (stillInProgress || !advanced || !treeClean) {
        await execProbe(
          resolveGitBin(),
          ['rebase', '--abort'],
          { cwd: worktreePath },
          mergeCtx,
        ).catch(() => {})
        return {
          merged: false,
          conflictResolved: false,
          aborted: true,
          output: `vcs-supervisor outcome rejected by git tree (stillInProgress=${stillInProgress}, advanced=${advanced}, treeClean=${treeClean}); rebase aborted.\n${output}`,
          supervisorConversation,
        }
      }
      conflictResolved = true
    }

    // Step 2: fast-forward integration to the (now-rebased) task branch via a
    // working-tree-free ref update. Unlike `git checkout` + `git merge --ff-only`,
    // `git update-ref` never touches any working tree, so it succeeds even when
    // the main working tree has uncommitted tracked changes or is checked out on
    // a different branch.
    const taskSha = (
      await exec(resolveGitBin(), ['rev-parse', branch], { cwd: repoRoot() }, mergeCtx)
    ).stdout.trim()
    const integrationSha = (
      await exec(resolveGitBin(), ['rev-parse', integrationBranch], { cwd: repoRoot() }, mergeCtx)
    ).stdout.trim()

    // Confirm fast-forward is valid: integrationSha must be an ancestor of taskSha.
    // `git merge-base --is-ancestor` exits 0 when true, 1 when false.
    const ancestryProbe = await execProbe(
      resolveGitBin(),
      ['merge-base', '--is-ancestor', integrationSha, taskSha],
      { cwd: repoRoot() },
      mergeCtx,
    )
    const ancestryOk = ancestryProbe.exitCode === 0

    if (!ancestryOk) {
      return {
        merged: false,
        conflictResolved,
        aborted: true,
        output: `fast-forward into ${integrationBranch} not possible: ${integrationSha} is not an ancestor of ${taskSha}.\n${output}`,
        supervisorConversation,
      }
    }

    // Bare ref update — does not touch any working tree, immune to dirty state.
    // The CAS form `update-ref <ref> <new> <old>` is atomic and rejects if
    // integrationBranch has been advanced concurrently (providing the same
    // race-safety as the file lock, with an additional CAS layer).
    try {
      await exec(
        resolveGitBin(),
        ['update-ref', `refs/heads/${integrationBranch}`, taskSha, integrationSha],
        { cwd: repoRoot() },
        mergeCtx,
      )
    } catch (casError: unknown) {
      const e = casError as { stdout?: string; stderr?: string; message?: string }
      output += (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '')
      return {
        merged: false,
        conflictResolved,
        aborted: true,
        output: `integration moved during merge, retry needed: ${integrationBranch} advanced concurrently.\n${output}`,
        supervisorConversation,
      }
    }

    // Step 3: re-sync the merge target's checkout to the advanced ref.
    // `update-ref` moved refs/heads/<integrationBranch> without touching any
    // working tree — by design, so a dirty/other-branch checkout cannot block
    // the merge. But when the main repo IS checked out on integrationBranch,
    // its index + working tree still reflect the OLD HEAD, so every file the
    // merge introduced now shows as a phantom staged change. That dirty index
    // then trips the dispatch-time `verify:main-dirty` guard and mass-parks
    // the whole queue behind a `main-commiter` recovery (one success poisons
    // every subsequent dispatch).
    //
    // Re-sync ONLY when both hold:
    //   1. HEAD is the integration branch (otherwise update-ref left the
    //      checkout legitimately untouched — see the non-integration test), and
    //   2. the working tree + index are clean *relative to the OLD integration
    //      SHA* the checkout still reflects. We must compare against
    //      integrationSha, NOT current HEAD: the ref already advanced, so a
    //      plain `git status` would report the just-merged files as "dirty"
    //      even on a pristine checkout and wrongly skip the re-sync.
    // When clean, `git reset --hard <taskSha>` materialises the merged content
    // and leaves `git status` empty. When the operator has real uncommitted
    // edits (a diff vs integrationSha) we leave the tree as-is rather than
    // clobber them — rare for the daemon's own checkout, and a dirty tree is
    // recoverable where lost edits are not. Failure here is non-fatal: the
    // merge already landed via the ref update; log and continue.
    try {
      const headBranch = (
        await exec(
          resolveGitBin(),
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          { cwd: repoRoot() },
          mergeCtx,
        )
      ).stdout.trim()
      if (headBranch === integrationBranch) {
        // `git diff --quiet <sha>` exits 0 when the working tree + index match
        // <sha> exactly (no genuine local work), non-zero otherwise. Probe form.
        const diffProbe = await execProbe(
          resolveGitBin(),
          ['diff', '--quiet', integrationSha],
          { cwd: repoRoot() },
          mergeCtx,
        )
        const cleanVsOldHead = diffProbe.exitCode === 0
        if (cleanVsOldHead) {
          const reset = await exec(
            resolveGitBin(),
            ['reset', '--hard', taskSha],
            { cwd: repoRoot() },
            mergeCtx,
          )
          output += reset.stdout + reset.stderr
        } else {
          output += `\n[mergeBranch] merge target checkout has local changes vs ${integrationSha.slice(0, 9)}; left as-is to avoid clobbering (HEAD ref advanced).`
        }
      }
    } catch (resyncError: unknown) {
      const e = resyncError as { stdout?: string; stderr?: string; message?: string }
      output += `\n[mergeBranch] post-merge checkout re-sync failed (merge already landed): ${(e.stderr ?? e.message ?? '').slice(0, 300)}`
    }

    return {
      merged: true,
      conflictResolved,
      aborted: false,
      output,
      supervisorConversation,
    }
  } finally {
    await release()
  }
}

export const isBranchMergedIntoMain = async (
  branch: string,
  repoRoot: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  const probe = await execProbe(
    resolveGitBin(),
    ['merge-base', '--is-ancestor', branch, 'main'],
    { cwd: repoRoot },
    traceCtx,
  )
  if (probe.exitCode !== 0) return false
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['rev-list', '--count', `${branch}..main`],
      { cwd: repoRoot },
      traceCtx,
    )
    const mainAhead = Number.parseInt(stdout.trim(), 10)
    if (!Number.isFinite(mainAhead)) return false
    return mainAhead === 0
  } catch {
    return false
  }
}

export const isZeroCommitBranch = async (
  branch: string,
  repoRoot: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  try {
    const { stdout: tip } = await exec(
      resolveGitBin(),
      ['rev-parse', branch],
      { cwd: repoRoot },
      traceCtx,
    )
    const { stdout: base } = await exec(
      resolveGitBin(),
      ['merge-base', branch, 'main'],
      { cwd: repoRoot },
      traceCtx,
    )
    return tip.trim() === base.trim()
  } catch {
    return false
  }
}
