/**
 * Worktree lifecycle hooks — per-repo `mars.json` setup/teardown commands.
 *
 * Consumer repos commit a `mars.json` at their root declaring commands that run
 * after the standard dependency-install step (setup hooks) and before worktree
 * removal (teardown hooks). This module owns the config parser, env builder,
 * command runner, and trust gate.
 *
 * Design decisions:
 * - Login shell (`bash -lc`) so the user's interactive PATH (nvm / pyenv /
 *   Homebrew) is available. Windows is not supported; hooks are skipped there
 *   with a warning.
 * - BASH_ENV is stripped from the child environment so a startup file cannot
 *   rewrite the environment behind Mars's back.
 * - Each command runs in its own process group (detached: true) so the whole
 *   subtree can be killed on timeout or abort.
 * - Output is ANSI-stripped and bounded to 64 KB (head + tail) so a chatty
 *   build tool cannot balloon memory or truncate the actual error at the tail.
 * - Hooks stop at the first non-zero exit code.
 * - A per-repo trust decision gates setup hooks. Until the repo is trusted,
 *   setup commands are not executed and an operator-decision item is raised in
 *   the action queue. Teardown hooks fire silently only when already trusted —
 *   they never prompt.
 */

import { spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// ANSI stripping and output truncation
// ---------------------------------------------------------------------------

/**
 * Matches CSI and OSC ANSI escape sequences (used to strip terminal colours).
 * OSC (`\x1B]...`) is listed first so `]` is not swallowed by the catch-all
 * single-char alternative `[@-Z\\-_]` (which also covers the `]` code point).
 */
const ANSI_RE = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')

/** 32 KB per side = 64 KB total budget. */
const HALF_BUDGET_BYTES = 32 * 1024

/**
 * Strip ANSI sequences and truncate `raw` to keep the first and last 32 KB.
 * When the content fits in 64 KB it is returned unchanged (minus ANSI). When
 * it is larger, the middle is replaced with a `...<output truncated>...` line
 * so both the head (context) and the tail (actual error) are preserved.
 */
export const truncateOutput = (raw: string): string => {
  const s = stripAnsi(raw)
  if (s.length <= HALF_BUDGET_BYTES * 2) return s
  const head = s.slice(0, HALF_BUDGET_BYTES)
  const tail = s.slice(s.length - HALF_BUDGET_BYTES)
  return `${head}\n...<output truncated>...\n${tail}`
}

// ---------------------------------------------------------------------------
// Config — mars.json at the repo root
// ---------------------------------------------------------------------------

export interface WorktreeHooksConfig {
  /** Shell commands to run after dep installation, in order. */
  setup: string[]
  /** Shell commands to run before worktree removal, in order. */
  teardown: string[]
}

/**
 * Normalise a config value to a `string[]`. Accepts:
 * - a single string    → `[string]`
 * - an array of strings → filtered to non-empty strings
 * - anything else       → `[]` (never throws)
 *
 * @internal Exported for unit tests.
 */
export const normalizeCommandList = (raw: unknown): string[] => {
  if (typeof raw === 'string') {
    const t = raw.trim()
    return t.length > 0 ? [t] : []
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return []
}

/**
 * Read and parse `mars.json` at `repoRoot`. Returns an empty config on any
 * error so a malformed or missing file never breaks worktree provisioning.
 */
export const parseHooksConfig = async (repoRoot: string): Promise<WorktreeHooksConfig> => {
  const empty: WorktreeHooksConfig = { setup: [], teardown: [] }
  try {
    const content = await readFile(resolve(repoRoot, 'mars.json'), 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      return empty
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const root = parsed as Record<string, unknown>
    const wt = root['worktree']
    if (wt === null || typeof wt !== 'object' || Array.isArray(wt)) return empty
    const worktree = wt as Record<string, unknown>
    return {
      setup: normalizeCommandList(worktree['setup']),
      teardown: normalizeCommandList(worktree['teardown']),
    }
  } catch {
    return empty
  }
}

// ---------------------------------------------------------------------------
// Env builder — single exported function, single source of truth
// ---------------------------------------------------------------------------

export interface HookEnvVars {
  /** Absolute, tilde-expanded path of the task worktree. */
  MARS_WORKTREE_PATH: string
  /** Absolute, tilde-expanded path of the repo root. */
  MARS_ROOT_PATH: string
  /** Git branch name the worktree is on (e.g. `task/abc123`). */
  MARS_BRANCH_NAME: string
  /** Mars task id driving this worktree. */
  MARS_TASK_ID: string
}

const expandTilde = (p: string): string => {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`
  return p
}

const resolveEnvPath = (p: string): string => resolve(expandTilde(p))

/**
 * Build the canonical hook environment variables from the given worktree facts.
 *
 * All paths are absolute, tilde-expanded, and slash-normalised before export
 * so that `cp "$MARS_ROOT_PATH/..."` always works regardless of how the caller
 * expressed the paths. This is the SINGLE source of truth: any future surface
 * (e.g. a CLI command that prints the hook env for a human to paste) MUST call
 * this function so the values never drift.
 */
export const buildHookEnv = (opts: {
  worktreePath: string
  rootPath: string
  branchName: string
  taskId: string
}): HookEnvVars => ({
  MARS_WORKTREE_PATH: resolveEnvPath(opts.worktreePath),
  MARS_ROOT_PATH: resolveEnvPath(opts.rootPath),
  MARS_BRANCH_NAME: opts.branchName,
  MARS_TASK_ID: opts.taskId,
})

// ---------------------------------------------------------------------------
// Per-command runner
// ---------------------------------------------------------------------------

export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000  // 10 minutes
export const DEFAULT_TOTAL_TIMEOUT_MS = 1_800_000  // 30 minutes

interface SingleCommandResult {
  exitCode: number
  output: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
}

const runSingleCommand = (
  cmd: string,
  hookEnv: HookEnvVars,
  opts: { commandTimeoutMs: number; signal?: AbortSignal },
): Promise<SingleCommandResult> => {
  return new Promise((resolvePromise) => {
    const startMs = Date.now()
    const isPosix = platform() !== 'win32'

    // Inherit parent env but drop BASH_ENV so a startup file cannot rewrite
    // the environment behind Mars's back.
    const { BASH_ENV: _dropped, ...baseEnv } = process.env as Record<string, string | undefined>
    const childEnv: NodeJS.ProcessEnv = { ...baseEnv, ...hookEnv }

    const chunks: Buffer[] = []
    let finished = false
    let timedOut = false
    let aborted = false

    const child = spawn('bash', ['-lc', cmd], {
      cwd: hookEnv.MARS_WORKTREE_PATH,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Create own process group so we can kill the whole subtree on timeout.
      detached: isPosix,
    })

    /** Kill the entire process group (or just the child on non-POSIX). */
    const killGroup = (sig: NodeJS.Signals = 'SIGKILL'): void => {
      if (child.pid === undefined) {
        try { child.kill(sig) } catch { /* ignore */ }
        return
      }
      try {
        if (isPosix) {
          process.kill(-child.pid, sig)
        } else {
          child.kill(sig)
        }
      } catch {
        try { child.kill(sig) } catch { /* ignore */ }
      }
    }

    // Per-command timeout
    const cmdTimer = setTimeout(() => {
      if (finished) return
      timedOut = true
      killGroup()
    }, opts.commandTimeoutMs)

    // Cooperative abort via AbortSignal
    const abortHandler = (): void => {
      if (finished) return
      aborted = true
      killGroup()
    }
    if (opts.signal?.aborted) {
      // Signal already fired before we even started — short-circuit.
      aborted = true
      // Will be resolved in the 'close' or 'error' handler after kill.
    }
    opts.signal?.addEventListener('abort', abortHandler, { once: true })
    if (aborted) killGroup()

    const onData = (buf: Buffer): void => { chunks.push(buf) }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const finish = (code: number): void => {
      if (finished) return
      finished = true
      clearTimeout(cmdTimer)
      opts.signal?.removeEventListener('abort', abortHandler)
      const raw = Buffer.concat(chunks).toString('utf8')
      resolvePromise({
        exitCode: code,
        output: truncateOutput(raw),
        durationMs: Date.now() - startMs,
        timedOut,
        aborted,
      })
    }

    child.on('close', (code) => finish(code ?? 1))
    child.on('error', (err) => {
      chunks.push(Buffer.from(err.message))
      finish(1)
    })
  })
}

// ---------------------------------------------------------------------------
// Hook runner (public)
// ---------------------------------------------------------------------------

export interface HookRunResult {
  /** True only when all commands exited 0 (or the list was empty). */
  success: boolean
  /** The command string that failed, if any. */
  failedCommand?: string
  /** 0-based index into the commands list. */
  failedCommandIndex?: number
  /** Exit code of the failed command. */
  exitCode?: number
  /** Wall-clock ms the failed command ran for. */
  durationMs?: number
  /** Captured output of the failed command (ANSI-stripped, ≤64 KB). */
  output?: string
  /** True when the whole-hook budget was exceeded. */
  timedOut?: boolean
  /** True when the caller's AbortSignal fired. */
  aborted?: boolean
  /** Non-empty when commands were skipped for a structural reason (non-POSIX, empty list). */
  skippedReason?: string
}

/**
 * Execute a list of shell commands sequentially under `bash -lc`, stopping at
 * the first failure.
 *
 * Each command receives the env vars returned by {@link buildHookEnv}, runs in
 * the worktree directory, and is bounded by `commandTimeoutMs`. A
 * `totalTimeoutMs` ceiling covers the whole hook list. Both timeouts kill the
 * entire process group, not just the direct child. The caller may also cancel
 * via `signal`.
 *
 * On Windows the hook list is skipped with `skippedReason: 'non-posix-platform'`
 * and `success: true` — hooks are a POSIX-only feature for now.
 */
export const runWorktreeHooks = async (opts: {
  commands: string[]
  hookEnv: HookEnvVars
  commandTimeoutMs?: number
  totalTimeoutMs?: number
  signal?: AbortSignal
  log?: (line: string) => void
}): Promise<HookRunResult> => {
  const {
    commands,
    hookEnv,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
    signal,
    log,
  } = opts

  if (platform() === 'win32') {
    log?.('[hooks] Windows platform — worktree hooks are not supported; skipping')
    return { success: true, skippedReason: 'non-posix-platform' }
  }
  if (commands.length === 0) return { success: true }

  // Total-budget controller — both the wall-clock timer and the caller's
  // AbortSignal funnel into this so commands receive a single signal.
  const totalAc = new AbortController()
  let totalTimedOut = false

  const totalTimer = setTimeout(() => {
    totalTimedOut = true
    totalAc.abort()
  }, totalTimeoutMs)

  const fwdAbort = (): void => totalAc.abort()
  signal?.addEventListener('abort', fwdAbort, { once: true })
  if (signal?.aborted) fwdAbort()

  try {
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]

      if (totalAc.signal.aborted) {
        if (totalTimedOut) {
          return {
            success: false,
            failedCommand: cmd,
            failedCommandIndex: i,
            timedOut: true,
            output: '[hook aborted: total timeout exceeded]',
          }
        }
        return {
          success: false,
          failedCommand: cmd,
          failedCommandIndex: i,
          aborted: true,
          output: '[hook aborted by signal]',
        }
      }

      log?.(`[hooks] running command ${i + 1}/${commands.length}: ${cmd}`)

      const result = await runSingleCommand(cmd, hookEnv, {
        commandTimeoutMs,
        signal: totalAc.signal,
      })

      log?.(
        `[hooks] command ${i + 1} exit=${result.exitCode} ` +
          `duration=${(result.durationMs / 1000).toFixed(1)}s`,
      )

      if (result.timedOut) {
        return {
          success: false,
          failedCommand: cmd,
          failedCommandIndex: i,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          output: result.output,
          timedOut: true,
        }
      }

      if (result.aborted) {
        // The totalAc fired — distinguish budget-exceeded from caller-signal.
        return {
          success: false,
          failedCommand: cmd,
          failedCommandIndex: i,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          output: result.output,
          ...(totalTimedOut ? { timedOut: true } : { aborted: true }),
        }
      }

      if (result.exitCode !== 0) {
        return {
          success: false,
          failedCommand: cmd,
          failedCommandIndex: i,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          output: result.output,
        }
      }
    }
    return { success: true }
  } finally {
    clearTimeout(totalTimer)
    signal?.removeEventListener('abort', fwdAbort)
  }
}

// ---------------------------------------------------------------------------
// Trust gate
// ---------------------------------------------------------------------------

const TRUST_FILE = 'worktree-trust.json'

const readTrustStore = async (stateDir: string): Promise<Record<string, boolean>> => {
  try {
    const content = await readFile(resolve(stateDir, TRUST_FILE), 'utf8')
    const parsed: unknown = JSON.parse(content)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, boolean>
  } catch {
    return {}
  }
}

/**
 * Whether the repo at `repoRoot` (absolute path) has been granted hook
 * execution trust by the operator.
 */
export const isRepoTrusted = async (
  repoRoot: string,
  stateDir: string,
): Promise<boolean> => {
  const store = await readTrustStore(stateDir)
  return store[resolve(repoRoot)] === true
}

/**
 * Record a one-time trust grant for `repoRoot`. Idempotent.
 * Persisted to `stateDir/worktree-trust.json` — gitignored daemon-local state.
 */
export const trustRepo = async (
  repoRoot: string,
  stateDir: string,
): Promise<void> => {
  const store = await readTrustStore(stateDir)
  store[resolve(repoRoot)] = true
  await mkdir(stateDir, { recursive: true })
  await writeFile(resolve(stateDir, TRUST_FILE), JSON.stringify(store, null, 2), 'utf8')
}

/**
 * Revoke the trust grant for `repoRoot`. Idempotent.
 */
export const untrustRepo = async (
  repoRoot: string,
  stateDir: string,
): Promise<void> => {
  const store = await readTrustStore(stateDir)
  delete store[resolve(repoRoot)]
  await mkdir(stateDir, { recursive: true })
  await writeFile(resolve(stateDir, TRUST_FILE), JSON.stringify(store, null, 2), 'utf8')
}
