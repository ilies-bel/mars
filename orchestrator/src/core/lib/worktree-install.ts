import { stat, rm, readFile } from 'node:fs/promises'
import { isAbsolute, resolve, relative } from 'node:path'
import { acquireLock } from './git/lock'
import { type RunSubprocessResult } from './git/claude'
import { getStateDir } from '../context'
import { runTool, nullTraceStore, type TraceCtx } from './run-tool'

export const DEFAULT_INSTALL_TIMEOUT_MS = 8 * 60_000

/** Maximum time to wait for a declared .d.ts/.d.cts file to appear after build. */
export const DECLARATION_WAIT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Install concurrency semaphore
//
// Limits how many worktree dependency installs run concurrently. The prepare
// script (tsup / esbuild + DTS) in packages/workflow is the per-install
// memory peak; allowing unlimited parallel installs OOM-kills the process
// (SIGKILL / exit 137) on memory-constrained hosts.
//
// Initialized from MARS_MAX_SETUP_INSTALL env var (default 2). The daemon
// calls setInstallSemCap() at startup and on `mars daemon reload` to keep
// the cap hot-reloadable without restarting, mirroring the per-kind
// setSemLimit pattern in core/daemon/server.ts.
// ---------------------------------------------------------------------------

const _readInstallEnvInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const _installSem = {
  limit: _readInstallEnvInt('MARS_MAX_SETUP_INSTALL', 2),
  inUse: 0,
  waiters: [] as Array<() => void>,
}

const _acquireInstallSem = (): Promise<void> => {
  if (_installSem.inUse < _installSem.limit) {
    _installSem.inUse += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => _installSem.waiters.push(resolve))
}

// When a waiter exists, hand the slot directly to it without bouncing inUse —
// otherwise a parallel acquire could slip in between decrement and resume.
const _releaseInstallSem = (): void => {
  const next = _installSem.waiters.shift()
  if (next) {
    next()
    return
  }
  _installSem.inUse = Math.max(0, _installSem.inUse - 1)
}

/**
 * Update the install concurrency cap at runtime.
 *
 * Raising the cap immediately wakes up to `delta` waiting install slots.
 * Lowering does NOT cancel in-flight installs — `_releaseInstallSem` will
 * simply not hand off to new acquirers until `inUse` drops below the new
 * limit naturally.
 *
 * Called by the daemon at startup and by the `reload-config` RPC handler
 * on `mars daemon reload`, mirroring the `setSemLimit` pattern used by
 * the per-kind dispatch semaphores in `core/daemon/server.ts`.
 */
export const setInstallSemCap = (newLimit: number): void => {
  if (!Number.isInteger(newLimit) || newLimit < 1) {
    throw new Error('limit must be a positive integer')
  }
  const delta = newLimit - _installSem.limit
  _installSem.limit = newLimit
  if (delta > 0 && _installSem.waiters.length > 0) {
    const wakeCount = Math.min(delta, _installSem.waiters.length)
    for (let i = 0; i < wakeCount; i++) {
      const next = _installSem.waiters.shift()
      if (next) {
        _installSem.inUse += 1
        next()
      }
    }
  }
}

/**
 * Returns the semaphore's live state.
 *
 * @internal Exported for testing and daemon observability.
 */
export const getInstallSemState = (): {
  limit: number
  inUse: number
  waiting: number
} => ({
  limit: _installSem.limit,
  inUse: _installSem.inUse,
  waiting: _installSem.waiters.length,
})

/**
 * Poll `fs.stat` until `filePath` exists and has non-zero size, or until
 * `timeoutMs` elapses. Resolves when the file appears; throws on timeout.
 *
 * @internal Exported for unit-testing; not part of the module's public API.
 */
export const waitForFile = async (
  filePath: string,
  { timeoutMs, intervalMs = 200 }: { timeoutMs: number; intervalMs?: number },
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const s = await stat(filePath)
      if (s.isFile() && s.size > 0) return
    } catch {
      // not yet present — fall through to sleep
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`file never materialized within ${timeoutMs}ms: ${filePath}`)
    }
    await new Promise<void>((r) => setTimeout(r, Math.min(intervalMs, remaining)))
  }
}

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
  installRoots: readonly string[] = ['.'],
): Promise<InstallSite[]> => {
  const found: InstallSite[] = []
  const visited = new Set<string>()
  const normalizedWorktreeRoot = resolve(worktreeRoot)

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited.has(dir)) return
    visited.add(dir)
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

  await Promise.all(
    installRoots.map(async (configuredRoot) => {
      const candidate = resolve(normalizedWorktreeRoot, configuredRoot)
      const candidateRelative = relative(normalizedWorktreeRoot, candidate)
      if (candidateRelative.startsWith('..') || isAbsolute(candidateRelative)) {
        throw new Error(`install root escapes worktree: ${configuredRoot}`)
      }
      await walk(candidate, 0)
    }),
  )
  return found
}

export const parseInstallRoots = (raw: string | undefined): readonly string[] | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined
  const roots = [...new Set(raw.split(',').map((root) => root.trim()).filter(Boolean))]
  return roots.length > 0 ? roots : undefined
}

/**
 * Build any local `file:` / `workspace:` workspace dependency that ships a
 * built `dist/` (i.e. declares a `build` script) BEFORE the site is installed.
 *
 * Why this is required: a `file:` dependency such as `@mars/workflow`
 * (`"@mars/workflow": "file:../packages/workflow"`) is packed by pnpm at
 * install time from whatever files match the package's `files` whitelist
 * (here `["dist"]`). In a freshly-created worktree the workspace package's
 * `dist/` has not been built yet, so pnpm materialises a `dist`-less copy into
 * the store. TypeScript then follows `node_modules/@mars/workflow` → that
 * `dist`-less copy → `TS2307 Cannot find module '@mars/workflow'`, and every
 * task fails `verify:typecheck`. Building `dist/` first means the subsequent
 * `pnpm install` packs a copy that carries the type declarations.
 *
 * Only same-worktree workspace packages are built; registry deps and `file:`
 * targets that escape the worktree root are ignored. A package with no `build`
 * script is skipped (nothing to build). The dep's OWN deps are installed first
 * (it carries its own lockfile) so its build toolchain — e.g. `tsup` — is on
 * PATH; building before that install would fail with `tsup: command not found`.
 * Install or build failures THROW — a workspace package that cannot build
 * would only fail typecheck later, more obscurely.
 *
 * Transient pnpm failures (exit 254 with empty stderr) are retried up to
 * {@link WORKSPACE_DEP_INSTALL_MAX_RETRIES} extra times, mirroring the
 * ENOTEMPTY retry pattern in {@link installWorktreeDeps}. After a successful
 * install the build-tool binary is verified to exist in `node_modules/.bin`;
 * if absent (pnpm exit-0 silent failure), a single re-install is attempted
 * before proceeding to the build step.
 *
 * @internal Exported for unit-testing the retry and bin-check paths; not part
 * of the module's public API.
 */

/** Extra install attempts after the initial try (mirrors ENOTEMPTY_MAX_RETRIES). */
const WORKSPACE_DEP_INSTALL_MAX_RETRIES = 2

/**
 * Extra build attempts after the initial try. Only used when the build exits
 * non-zero with BOTH stdout AND stderr empty — a transient race (store-lock /
 * bin-resolution), never a real compiler error. A compiler error always emits
 * diagnostics to stdout or stderr and is NOT retried.
 */
const WORKSPACE_DEP_BUILD_MAX_RETRIES = 2

export const buildWorkspaceDepsForSite = async (
  site: InstallSite,
  worktreeRoot: string,
  runner: InstallRunner,
  log: ((line: string) => void) | undefined,
  timeoutMs: number,
  declarationTimeoutMs = DECLARATION_WAIT_TIMEOUT_MS,
): Promise<void> => {
  // All JS package managers (pnpm/npm/yarn/bun) that use file: workspace deps
  // need the pre-build step. Non-JS repos have no lockfile, so detectInstallSites
  // returns empty and this function is never called for them.
  let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(await readFile(resolve(site.dir, 'package.json'), 'utf8'))
  } catch {
    return
  }
  const deps = { ...manifest.dependencies, ...manifest.devDependencies }
  const built = new Set<string>()
  for (const spec of Object.values(deps)) {
    // Only `file:` and `workspace:` specs pack a copy into the consumer's
    // node_modules — those are the ones that need a built `dist/` on disk
    // before the consumer's install runs. `link:` deps are symlinks (pnpm
    // does no packing), so pre-building is pointless and actively harmful:
    // the linked package is typically its OWN install site, and running
    // `pnpm install` + `pnpm run build` against it from here races with the
    // linked package's own setup that's running in parallel — and worse,
    // the linked package's build (e.g. `tsc --noEmit`) routinely depends on
    // workspace deps whose dist won't exist until that other site finishes.
    // Skip `link:` entirely; the linked package's own install site owns its
    // install+build.
    const m = /^(?:file:|workspace:)(.+)$/.exec(spec)
    if (!m) continue
    const depDir = resolve(site.dir, m[1].replace(/^workspace:/, ''))
    // Stay inside the worktree; ignore deps that escape the checkout.
    const rootWithSep = worktreeRoot.endsWith('/') ? worktreeRoot : `${worktreeRoot}/`
    if (depDir !== worktreeRoot && !depDir.startsWith(rootWithSep)) continue
    if (built.has(depDir)) continue
    let depManifest: {
      name?: string
      scripts?: Record<string, string>
      types?: string
      typings?: string
      exports?: Record<string, unknown>
    }
    try {
      depManifest = JSON.parse(await readFile(resolve(depDir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (!depManifest.scripts?.build) continue
    built.add(depDir)
    const rel = relative(worktreeRoot, depDir) || '.'

    // Install the dep's own deps first so its build toolchain (tsup, tsc, …)
    // is available. The package may carry its own lockfile, so a frozen install
    // is reproducible; fall back to a plain install if no lockfile is present.
    // CI=true mirrors the consuming-site install so the package manager won't
    // abort on a TTY-less modules-dir purge.
    const lockfileByManager: Record<PackageManager, string> = {
      pnpm: 'pnpm-lock.yaml',
      npm: 'package-lock.json',
      yarn: 'yarn.lock',
      bun: 'bun.lockb',
    }
    const depHasLockfile = await fileExists(resolve(depDir, lockfileByManager[site.manager]))
    // installCommand gives the frozen args (e.g. ['ci'] for npm, ['install', '--frozen-lockfile']
    // for pnpm/yarn/bun). Without a lockfile, fall back to a plain 'install' for all managers.
    const [, frozenInstallArgs] = installCommand(site.manager)
    const depInstallArgs: readonly string[] = depHasLockfile ? frozenInstallArgs : ['install']
    log?.(`[setup:install] installing workspace dep (${rel}) deps before build`)

    // (a) Initial install with retry on transient exit 254 + empty stderr.
    // pnpm emits exit 254 with no stderr output during brief CI races (store
    // lock contention, flock timeout). Retrying without any cleanup is safe
    // because the store is left intact on a 254 abort.
    let installRes = await runner(site.manager, depInstallArgs, depDir, {
      timeoutMs,
      env: { CI: 'true' },
    })
    for (
      let attempt = 1;
      attempt <= WORKSPACE_DEP_INSTALL_MAX_RETRIES &&
      installRes.exitCode === 254 &&
      installRes.stderr.trim() === '';
      attempt++
    ) {
      log?.(
        `[setup:install] workspace dep (${rel}) transient exit 254 — retrying (attempt ${attempt}/${WORKSPACE_DEP_INSTALL_MAX_RETRIES})`,
      )
      installRes = await runner(site.manager, depInstallArgs, depDir, {
        timeoutMs,
        env: { CI: 'true' },
      })
    }

    if (installRes.exitCode !== 0) {
      const debugHint =
        site.manager === 'pnpm'
          ? `pnpm-debug.log: ${resolve(depDir, 'pnpm-debug.log')}\n`
          : ''
      if (site.manager === 'pnpm') {
        log?.(
          `[setup:install] workspace dep install failed; pnpm-debug.log may have signal at: ${resolve(depDir, 'pnpm-debug.log')}`,
        )
      }
      throw new Error(
        `[setup:install] workspace dep install failed (${rel}): ${site.manager} ${depInstallArgs.join(' ')} exited ${installRes.exitCode}\n` +
          debugHint +
          `stderr (truncated):\n${installRes.stderr.slice(0, 1000)}\n` +
          `stdout (truncated):\n${installRes.stdout.slice(0, 1000)}`,
      )
    }

    // (b) After a successful install, verify the build-tool binary is present
    // in node_modules/.bin. pnpm can exit 0 while leaving the bin tree
    // incomplete (a known silent failure mode), causing the subsequent
    // `pnpm run build` to abort with "tsup: command not found". A single
    // re-install recovers this without needing a full retry loop.
    const buildScript = depManifest.scripts?.build ?? ''
    const buildTool = buildScript.trim().split(/\s+/)[0] ?? ''
    if (buildTool && !buildTool.includes('/')) {
      const binPath = resolve(depDir, 'node_modules', '.bin', buildTool)
      if (!(await fileExists(binPath))) {
        log?.(
          `[setup:install] workspace dep (${rel}) node_modules/.bin/${buildTool} missing after install — re-installing once`,
        )
        const reInstallRes = await runner(site.manager, depInstallArgs, depDir, {
          timeoutMs,
          env: { CI: 'true' },
        })
        if (reInstallRes.exitCode !== 0) {
          const reDebugHint =
            site.manager === 'pnpm'
              ? `pnpm-debug.log: ${resolve(depDir, 'pnpm-debug.log')}\n`
              : ''
          if (site.manager === 'pnpm') {
            log?.(
              `[setup:install] workspace dep re-install failed; check pnpm-debug.log at: ${resolve(depDir, 'pnpm-debug.log')}`,
            )
          }
          throw new Error(
            `[setup:install] workspace dep re-install failed (${rel}): ${site.manager} ${depInstallArgs.join(' ')} exited ${reInstallRes.exitCode}\n` +
              reDebugHint +
              `stderr (truncated):\n${reInstallRes.stderr.slice(0, 1000)}\n` +
              `stdout (truncated):\n${reInstallRes.stdout.slice(0, 1000)}`,
          )
        }
      }
    }

    log?.(`[setup:install] building workspace dep (${rel}) before install so its dist is packed`)
    let r = await runner(site.manager, ['run', 'build'], depDir, {
      timeoutMs,
      env: { CI: 'true' },
    })
    // Retry ONLY on the known-transient signature: non-zero exit with BOTH
    // stdout AND stderr empty. A real compiler error (tsc, tsup) always emits
    // diagnostics to stdout or stderr — if either has content we surface the
    // failure immediately so real type errors are never masked by a retry.
    for (
      let attempt = 1;
      attempt <= WORKSPACE_DEP_BUILD_MAX_RETRIES &&
      r.exitCode !== 0 &&
      r.stderr.trim() === '' &&
      r.stdout.trim() === '';
      attempt++
    ) {
      log?.(
        `[setup:install] workspace dep (${rel}) transient build exit ${r.exitCode} (no output) — retrying (attempt ${attempt}/${WORKSPACE_DEP_BUILD_MAX_RETRIES})`,
      )
      r = await runner(site.manager, ['run', 'build'], depDir, {
        timeoutMs,
        env: { CI: 'true' },
      })
    }
    // Rollup optional-dependency race (pnpm v10): pnpm exits 0 but does not
    // create the platform-specific native binary symlink (e.g.
    // @rollup/rollup-darwin-arm64). The subsequent `pnpm run build` (tsup's
    // rollup DTS pass) exits 1 with "Cannot find module @rollup/rollup-xxx".
    // Retrying the build alone doesn't help because the missing symlink is in
    // node_modules. The fix is to wipe node_modules and reinstall so pnpm
    // re-creates the full link tree, then retry the build once.
    if (
      r.exitCode !== 0 &&
      (r.stderr + r.stdout).includes('Cannot find module @rollup/rollup-')
    ) {
      log?.(
        `[setup:install] workspace dep (${rel}) rollup optional-dep race detected — wiping node_modules and reinstalling`,
      )
      await rm(resolve(depDir, 'node_modules'), { recursive: true, force: true })
      const repairInstallRes = await runner(site.manager, depInstallArgs, depDir, {
        timeoutMs,
        env: { CI: 'true' },
      })
      if (repairInstallRes.exitCode !== 0) {
        throw new Error(
          `[setup:install] workspace dep repair install failed (${rel}): ${site.manager} ${depInstallArgs.join(' ')} exited ${repairInstallRes.exitCode}\n` +
            `stderr (truncated):\n${repairInstallRes.stderr.slice(0, 1000)}\n` +
            `stdout (truncated):\n${repairInstallRes.stdout.slice(0, 1000)}`,
        )
      }
      r = await runner(site.manager, ['run', 'build'], depDir, {
        timeoutMs,
        env: { CI: 'true' },
      })
    }
    if (r.exitCode !== 0) {
      // Include BOTH stderr and stdout: `tsc --noEmit`, `tsup`'s DTS pass,
      // and several other build tools emit failure detail on stdout, not
      // stderr. The original `link:` pre-build regression (3c78adcc) surfaced
      // here as `workspace dep build failed (orchestrator): pnpm run build
      // exited 2` with empty stderr — the actual TS error went to stdout and
      // was discarded, leaving operators with no diagnostic.
      throw new Error(
        `[setup:install] workspace dep build failed (${rel}): ${site.manager} run build exited ${r.exitCode}\n` +
          `stderr (truncated):\n${r.stderr.slice(0, 1000)}\n` +
          `stdout (truncated):\n${r.stdout.slice(0, 1000)}`,
      )
    }

    // Declaration-existence barrier: if the dep's package.json declares type
    // entrypoints (.d.ts / .d.cts), assert they exist on disk before returning
    // control to the install step. Build tools (e.g. tsup with dts:true) can
    // exit 0 before their declaration pass has finished writing the .d.ts
    // files, so pnpm may hardlink a dist/ with JS but no declarations →
    // downstream `tsc --noEmit` fails TS7016. A thrown error here surfaces as
    // a classified setup failure instead of a confusing downstream typecheck
    // error — that is the desired behavior.
    const declPaths: string[] = []
    if (typeof depManifest.types === 'string') {
      declPaths.push(resolve(depDir, depManifest.types))
    }
    if (typeof depManifest.typings === 'string') {
      declPaths.push(resolve(depDir, depManifest.typings))
    }
    if (depManifest.exports != null && typeof depManifest.exports === 'object') {
      for (const exportValue of Object.values(depManifest.exports)) {
        if (
          exportValue != null &&
          typeof exportValue === 'object' &&
          !Array.isArray(exportValue)
        ) {
          const conds = exportValue as Record<string, unknown>
          if (typeof conds['types'] === 'string') {
            declPaths.push(resolve(depDir, conds['types']))
          }
        }
      }
    }
    for (const declPath of declPaths) {
      if (!declPath.endsWith('.d.ts') && !declPath.endsWith('.d.cts')) continue
      try {
        await waitForFile(declPath, { timeoutMs: declarationTimeoutMs })
      } catch {
        const depName = typeof depManifest.name === 'string' ? depManifest.name : rel
        throw new Error(
          `[setup:install] ${depName} build finished but declaration ${declPath} never materialized; refusing to install a declaration-less dist`,
        )
      }
    }
  }
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

/**
 * The NON-frozen install command for a manager — the one that *rewrites*
 * the lockfile to match the manifest. Used only by {@link repairInstallInPlace}
 * to reconcile a drifted lockfile in place; the normal setup path is always
 * frozen ({@link installCommand}) so concurrent worktrees stay reproducible.
 */
export const regenInstallCommand = (
  manager: PackageManager,
): readonly [string, readonly string[]] => {
  switch (manager) {
    case 'pnpm':
      return ['pnpm', ['install', '--no-frozen-lockfile']]
    case 'npm':
      return ['npm', ['install']]
    case 'yarn':
      return ['yarn', ['install']]
    case 'bun':
      return ['bun', ['install']]
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

/**
 * A package manager reported a successful install but did not leave a usable
 * module tree for a package that setup must make runnable. This is a setup
 * environment failure, never a later typecheck failure.
 */
export class WorktreeModulesMissingError extends Error {
  readonly site: InstallSite
  readonly failureStep = 'setup:modules-missing'

  constructor(site: InstallSite) {
    super(`${site.dir}/node_modules is missing after a successful install`)
    this.name = 'WorktreeModulesMissingError'
    this.site = site
  }
}

export type InstallRunner = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunSubprocessResult>

export interface InstallWorktreeDepsOptions {
  worktreeRoot: string
  runner?: InstallRunner
  log?: (line: string) => void
  timeoutMs?: number
  /**
   * Repository-relative roots whose dependency lockfiles should be installed.
   * When omitted, MARS_INSTALL_ROOTS is parsed as a comma-separated list.
   * When neither is configured, the whole worktree is scanned.
   */
  installRoots?: readonly string[]
  /**
   * Assert each discovered package manager site has a module tree once setup
   * completes. Setup enables this so a package-manager no-op cannot surface
   * later as a misleading verify:typecheck failure.
   */
  requireModuleTrees?: boolean
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
      env: opts?.env,
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
  installRoots = parseInstallRoots(process.env.MARS_INSTALL_ROOTS),
  requireModuleTrees = false,
  traceCtx,
}: InstallWorktreeDepsOptions): Promise<WorktreeInstallSummary> => {
  const effectiveRunner = runner ?? makeDefaultInstallRunner(traceCtx)
  const sites = await detectInstallSites(worktreeRoot, 3, installRoots)
  if (sites.length === 0) {
    return { sites: [], totalDurationMs: 0 }
  }

  const start = Date.now()
  const results = await Promise.all(
    sites.map(async (site) => {
      // Gate the entire per-site install (workspace dep build + frozen install)
      // behind the install semaphore. The prepare script (tsup / esbuild + DTS)
      // in packages/workflow is the per-install memory peak; without this gate,
      // parallel worktree setups ran concurrent tsup invocations and OOM-killed
      // the process (SIGKILL / exit 137). Worktree git operations stay parallel;
      // only the dependency-install step is serialised up to the cap.
      await _acquireInstallSem()
      try {
        const [cmd, args] = installCommand(site.manager)
        const rel = relative(worktreeRoot, site.dir) || '.'
        // Build any local workspace `file:`/`workspace:` deps (e.g.
        // `@mars/workflow`) BEFORE installing, so pnpm packs a copy that
        // carries the built `dist/` (and its type declarations). Without this,
        // a fresh worktree gets a dist-less copy and every task fails
        // `verify:typecheck` with TS2307.
        await buildWorkspaceDepsForSite(
          site,
          worktreeRoot,
          effectiveRunner,
          log,
          timeoutMs,
        )
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
      } finally {
        _releaseInstallSem()
      }
    }),
  )
  if (requireModuleTrees) {
    for (const site of sites) {
      if (!(await dirExists(resolve(site.dir, 'node_modules')))) {
        throw new WorktreeModulesMissingError(site)
      }
    }
  }
  return { sites: results, totalDurationMs: Date.now() - start }
}

/** Process-wide lock serializing lockfile regeneration across all worktrees. */
export const INSTALL_REGEN_LOCK_TIMEOUT_MS = 10 * 60_000

/**
 * Per-lock-path in-process mutex. The cross-process file lock (`acquireLock`)
 * deliberately treats a lock held by the *current* process as reclaimable
 * (its `isLockStale` returns true when `pid === process.pid`), so two
 * concurrent regenerations inside the SAME daemon process would both acquire
 * it. Concurrent worktree setups run in one daemon process, so we also need an
 * intra-process gate. This promise-chain mutex serializes same-process callers;
 * the file lock then serializes across separate daemon processes.
 */
const inProcessRegenChains = new Map<string, Promise<void>>()

const withInProcessRegenLock = async <T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const prior = inProcessRegenChains.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  // Tail of the chain = wait for prior, then for this caller to release.
  const tail = prior.then(() => next)
  inProcessRegenChains.set(key, tail)
  await prior
  try {
    return await fn()
  } finally {
    release()
    // If no later caller chained on after us, drop the entry so the map
    // doesn't grow unbounded across thousands of installs.
    if (inProcessRegenChains.get(key) === tail) {
      inProcessRegenChains.delete(key)
    }
  }
}

export interface RepairInstallInPlaceOptions {
  /** The install site that failed its frozen install. */
  site: InstallSite
  runner?: InstallRunner
  log?: (line: string) => void
  timeoutMs?: number
  traceCtx?: TraceCtx
  /** Override the regen lock path (tests). Defaults to `<stateDir>/.install-regen.lock`. */
  lockPath?: string
  /** Override the regen lock timeout (tests). */
  lockTimeoutMs?: number
}

export interface RepairInstallInPlaceResult {
  /** Did the frozen install pass after regeneration? */
  repaired: boolean
  /** Did the lockfile contents actually change? Caller commits only when true. */
  lockfileChanged: boolean
  /** Absolute path to the lockfile that was (re)generated. */
  lockfilePath: string
  /** Combined stdout/stderr of the final frozen install (for the failure path). */
  output: string
}

const readFileOrEmpty = async (path: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Reconcile a drifted lockfile **in place**, inside the failing task's own
 * worktree, instead of spawning a separate recovery task that regenerates
 * the lockfile on its own branch and merges its own diff.
 *
 * Why in place: two concurrent recovery branches that each regenerate a
 * shared lockfile produce non-mergeable diffs (a non-frozen install is
 * non-deterministic across wall-clock / registry state), which then collide
 * at the merge step. By repairing in the origin worktree there is exactly
 * ONE branch carrying the lockfile change — the origin's — which continues
 * through verify → merge normally. This is the structural fix for the
 * recovery-merge lockfile-drift class.
 *
 * The regeneration is serialized process-wide via a file lock so two
 * worktrees can never rewrite the same root/shared lockfile at once.
 *
 * Steps: acquire regen lock → clear node_modules → non-frozen install
 * (rewrites the lockfile) → frozen install (proves the lockfile is now
 * reproducible). `repaired` is true only when the final frozen install
 * exits 0. The caller commits the lockfile (+ manifest) when
 * `lockfileChanged` is true, then lets the workflow continue.
 */
export const repairInstallInPlace = async ({
  site,
  runner,
  log,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  traceCtx,
  lockPath,
  lockTimeoutMs = INSTALL_REGEN_LOCK_TIMEOUT_MS,
}: RepairInstallInPlaceOptions): Promise<RepairInstallInPlaceResult> => {
  const effectiveRunner = runner ?? makeDefaultInstallRunner(traceCtx)
  const lockfilePath = resolve(site.dir, site.lockfile)
  const resolvedLockPath =
    lockPath ?? resolve(getStateDir(), '.install-regen.lock')

  const before = await readFileOrEmpty(lockfilePath)

  // Serialize lockfile regeneration so concurrent origins cannot produce two
  // divergent lockfiles for the same shared manifest. Two layers, keyed on the
  // same lock path:
  //   - an in-process mutex serializes callers in THIS daemon process (the
  //     file lock alone does not, since it treats a same-pid lock as stale);
  //   - the cross-process file lock serializes across separate daemon
  //     processes (e.g. two repos, or a restarted daemon).
  return withInProcessRegenLock(resolvedLockPath, async () => {
    const release = await acquireLock(resolvedLockPath, lockTimeoutMs)
    try {
      // Clear node_modules so the regen install starts from a clean tree (and
      // to dodge the same ENOTEMPTY cleanup race the frozen path guards
      // against).
      await rm(resolve(site.dir, 'node_modules'), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      })

      const [regenCmd, regenArgs] = regenInstallCommand(site.manager)
      log?.(
        `[setup:install] ${site.manager} (${site.dir}) reconciling lockfile in place: ${regenCmd} ${regenArgs.join(' ')}`,
      )
      const regen = await effectiveRunner(regenCmd, regenArgs, site.dir, {
        timeoutMs,
      })
      if (regen.exitCode !== 0) {
        return {
          repaired: false,
          lockfileChanged: false,
          lockfilePath,
          output: `${regen.stdout}\n${regen.stderr}`,
        }
      }

      // Prove the regenerated lockfile is reproducible: re-run the FROZEN
      // install. If this passes, the drift is genuinely reconciled.
      const [frozenCmd, frozenArgs] = installCommand(site.manager)
      const frozen = await effectiveRunner(frozenCmd, frozenArgs, site.dir, {
        timeoutMs,
      })
      const after = await readFileOrEmpty(lockfilePath)
      return {
        repaired: frozen.exitCode === 0,
        lockfileChanged: after !== before,
        lockfilePath,
        output: `${frozen.stdout}\n${frozen.stderr}`,
      }
    } finally {
      await release()
    }
  })
}
