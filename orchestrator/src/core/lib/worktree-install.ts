import { stat } from 'node:fs/promises'
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

/**
 * Post-install guard for local file: packages that produce a dist/ build.
 *
 * After pnpm copies a file: dependency to its virtual store it only includes
 * files that existed on disk at copy time. Because `dist/` is gitignored,
 * a fresh worktree or a `rm -rf dist` scenario leaves the virtual-store entry
 * without dist, and `node_modules/@mars/workflow/dist/index.js` does not
 * exist.
 *
 * The primary guard is the `postinstall` hook in orchestrator/package.json
 * (scripts/ensure-local-deps-built.mjs), which builds dist and copies it into
 * node_modules after every pnpm install. This function is a secondary safety
 * net invoked from the setup-worktree workflow step for any site that has
 * @mars/workflow but still lacks dist after install — covering edge cases
 * where the postinstall hook was not executed (e.g. non-standard install
 * invocations or install sites other than orchestrator/).
 *
 * This function detects that condition for `@mars/workflow` and:
 *  1. Logs a clear message so the operator knows what is happening.
 *  2. Runs `npm run build` in the package source directory to produce dist.
 *  3. Copies the built dist into the node_modules entry (which points into
 *     the pnpm virtual store) so the package is immediately importable.
 *
 * Safe to call repeatedly — no-ops in under a millisecond when dist already
 * exists.  Non-fatal: if the build or copy fails the function logs and
 * returns without throwing; tsx path-alias resolution keeps the dev workflow
 * functional even without dist.
 *
 * @param siteDir   The install site directory (the directory that owns
 *                  node_modules, i.e. the orchestrator directory inside the
 *                  worktree).
 * @param runner    The same runner used for the pnpm/npm install commands.
 * @param log       Optional line logger.
 */
export const ensureLocalDistBuilt = async (
  siteDir: string,
  runner: InstallRunner,
  log?: (line: string) => void,
): Promise<void> => {
  const nmWorkflow = resolve(siteDir, 'node_modules', '@mars', 'workflow')
  const nmWorkflowDist = resolve(nmWorkflow, 'dist', 'index.js')

  // Fast path: dist already present — nothing to do.
  if (await fileExists(nmWorkflowDist)) return

  // @mars/workflow not installed in this site at all — not our concern.
  if (!await dirExists(nmWorkflow)) return

  // Locate the source package. In the monorepo layout the orchestrator sits
  // one level below the repo root, and packages/ is a sibling of orchestrator.
  const srcDir = resolve(siteDir, '..', 'packages', 'workflow')
  if (!await dirExists(srcDir)) {
    log?.(
      `[setup:install] @mars/workflow: dist/index.js absent from node_modules ` +
      `but source dir ${srcDir} not found — skipping rebuild`,
    )
    return
  }

  log?.(
    `[setup:install] @mars/workflow: dist/index.js absent from node_modules after install, ` +
    `rebuilding from ${srcDir}`,
  )

  const result = await runner('npm', ['run', 'build'], srcDir)
  if (result.exitCode !== 0) {
    log?.(
      `[setup:install] @mars/workflow: build failed (exit ${result.exitCode}) — ` +
      `tsx path-alias will still work but plain-node imports of @mars/workflow will fail`,
    )
    return
  }

  // Inject the freshly built dist/ into the node_modules entry.  The entry is
  // the pnpm virtual-store copy (a real directory, not a symlink), so writing
  // into it is safe and immediately visible to importers.
  const srcDist = resolve(srcDir, 'dist')
  if (await dirExists(srcDist)) {
    try {
      const { cp } = await import('node:fs/promises')
      await cp(srcDist, resolve(nmWorkflow, 'dist'), { recursive: true })
      log?.(`[setup:install] @mars/workflow: dist rebuilt and injected into node_modules`)
    } catch (copyErr) {
      log?.(
        `[setup:install] @mars/workflow: dist built but copy into node_modules failed: ` +
        `${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
      )
    }
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
      const t0 = Date.now()
      const r = await effectiveRunner(cmd, args, site.dir, { timeoutMs })
      const durationMs = Date.now() - t0
      const rel = relative(worktreeRoot, site.dir) || '.'
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
