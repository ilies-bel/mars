import { stat, rm } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { type RunSubprocessResult } from './git'
import { runTool, nullTraceStore, type TraceCtx } from './run-tool'

export const DEFAULT_INSTALL_TIMEOUT_MS = 8 * 60_000

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

export interface InstallSite {
  dir: string
  manager: PackageManager
  lockfile: string
}

export interface InstallResult extends InstallSite {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface WorktreeInstallSummary {
  sites: InstallResult[]
  totalDurationMs: number
}

const LOCKFILES: ReadonlyArray<{ name: string; manager: PackageManager }> = [
  { name: 'pnpm-lock.yaml', manager: 'pnpm' },
  { name: 'package-lock.json', manager: 'npm' },
  { name: 'yarn.lock', manager: 'yarn' },
  { name: 'bun.lockb', manager: 'bun' },
]

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.mars',
  '.worktrees',
  'dist',
  'build',
  '.next',
  'target',
  'out',
])

const fileExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path)
    return s.isFile()
  } catch {
    return false
  }
}

const dirExists = async (path: string): Promise<boolean> => {
  try {
    const s = await stat(path)
    return s.isDirectory()
  } catch {
    return false
  }
}

const detectInDir = async (dir: string): Promise<InstallSite | null> => {
  for (const { name, manager } of LOCKFILES) {
    const lockPath = resolve(dir, name)
    if (await fileExists(lockPath)) {
      return { dir, manager, lockfile: name }
    }
  }
  return null
}

export const detectInstallSites = async (
  worktreeRoot: string,
  maxDepth = 3,
): Promise<InstallSite[]> => {
  const found: InstallSite[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    const site = await detectInDir(dir)
    if (site) {
      found.push(site)
    }
    if (depth >= maxDepth) return
    let entries: string[]
    try {
      const { readdir } = await import('node:fs/promises')
      entries = await readdir(dir)
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (SKIP_DIRS.has(entry)) return
        if (entry.startsWith('.')) return
        const child = resolve(dir, entry)
        if (await dirExists(child)) {
          await walk(child, depth + 1)
        }
      }),
    )
  }

  await walk(worktreeRoot, 0)
  return found
}

export const installCommand = (
  manager: PackageManager,
): readonly [string, readonly string[]] => {
  switch (manager) {
    case 'pnpm':
      return ['pnpm', ['install', '--frozen-lockfile']]
    case 'npm':
      return ['npm', ['ci']]
    case 'yarn':
      return ['yarn', ['install', '--frozen-lockfile']]
    case 'bun':
      return ['bun', ['install', '--frozen-lockfile']]
  }
}

export class WorktreeInstallError extends Error {
  readonly site: InstallSite
  readonly result: RunSubprocessResult

  constructor(site: InstallSite, result: RunSubprocessResult) {
    const cmd = installCommand(site.manager)
    const summary =
      `${cmd[0]} ${cmd[1].join(' ')} (cwd=${site.dir}) exited with ${result.exitCode}\n` +
      `stderr (truncated):\n${result.stderr.slice(0, 1500)}\n` +
      `stdout (truncated):\n${result.stdout.slice(0, 500)}`
    super(summary)
    this.name = 'WorktreeInstallError'
    this.site = site
    this.result = result
  }
}

export type InstallRunner = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  opts?: { timeoutMs?: number },
) => Promise<RunSubprocessResult>

export interface InstallWorktreeDepsOptions {
  worktreeRoot: string
  runner?: InstallRunner
  log?: (line: string) => void
  timeoutMs?: number
  /** Optional trace context. When supplied, the default runner emits a
   *  `tool_invoked` event per install via `runTool`. Custom runners are
   *  responsible for their own tracing. */
  traceCtx?: TraceCtx
}

const makeDefaultInstallRunner = (
  traceCtx: TraceCtx | undefined,
): InstallRunner => async (cmd, args, cwd, opts) => {
  const store = traceCtx?.store ?? nullTraceStore
  const r = await runTool(
    {
      tool: cmd,
      argv: [...args],
      cwd,
      timeoutMs: opts?.timeoutMs,
      taskId: traceCtx?.taskId ?? null,
      originId: traceCtx?.originId ?? null,
      phase: traceCtx?.phase ?? 'setup',
    },
    store,
  )
  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
  }
}

export const installWorktreeDeps = async ({
  worktreeRoot,
  runner,
  log,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  traceCtx,
}: InstallWorktreeDepsOptions): Promise<WorktreeInstallSummary> => {
  const effectiveRunner = runner ?? makeDefaultInstallRunner(traceCtx)
  const sites = await detectInstallSites(worktreeRoot)
  if (sites.length === 0) {
    return { sites: [], totalDurationMs: 0 }
  }

  const start = Date.now()
  const results = await Promise.all(
    sites.map(async (site) => {
      const [cmd, args] = installCommand(site.manager)
      const rel = relative(worktreeRoot, site.dir) || '.'
      const t0 = Date.now()
      let r = await effectiveRunner(cmd, args, site.dir, { timeoutMs })

      // Retry on transient ENOTEMPTY filesystem race (macOS npm ci cleanup race).
      // This occurs when a prior process holds file descriptors open in node_modules
      // while npm tries to rmdir the stale tree before a fresh install. The failed
      // cleanup leaves a partially corrupt node_modules behind, so each retry must
      // clear it first — otherwise the second install hits ENOENT chmod errors on
      // the half-removed tree (e.g. node_modules/esbuild/bin/esbuild).
      //
      // We allow up to ENOTEMPTY_MAX_RETRIES additional attempts: a single retry
      // was empirically not enough — the race can recur when the same fs handle
      // holder (a concurrent worktree install, a Spotlight indexer) is still
      // active a moment later. The rm() between attempts uses node's built-in
      // retry to absorb brief EBUSY/EPERM races on the cleanup itself.
      const ENOTEMPTY_MAX_RETRIES = 2
      for (
        let attempt = 1;
        attempt <= ENOTEMPTY_MAX_RETRIES && r.exitCode !== 0 && /ENOTEMPTY/.test(r.stderr);
        attempt++
      ) {
        log?.(
          `[setup:install] ${site.manager} (${rel}) ENOTEMPTY race detected — retrying (attempt ${attempt}/${ENOTEMPTY_MAX_RETRIES})`,
        )
        await rm(resolve(site.dir, 'node_modules'), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        })
        r = await effectiveRunner(cmd, args, site.dir, { timeoutMs })
      }

      const durationMs = Date.now() - t0
      log?.(
        `[setup:install] ${site.manager} (${rel}) exit=${r.exitCode} duration=${(durationMs / 1000).toFixed(1)}s`,
      )
      const result: InstallResult = {
        ...site,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs,
      }
      if (r.exitCode !== 0) {
        throw new WorktreeInstallError(site, r)
      }
      return result
    }),
  )
  return { sites: results, totalDurationMs: Date.now() - start }
}
