import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { resolveVcs } from '../ports/vcs/registry'

/**
 * Fallback workspace list used when `pnpm-workspace.yaml` is absent,
 * unparseable, or declares no `packages` entries — e.g. Mars orchestrating a
 * repo that does not have this framework's layout, or a stripped-down test
 * fixture. {@link resolveDependencyWorkspaces} reads the committed workspace
 * file whenever one is present, so this constant only covers the degraded
 * path; keep it in sync with the framework's actual package layout anyway so
 * that degraded path stays correct.
 */
const FALLBACK_DEPENDENCY_WORKSPACES = [
  'orchestrator',
  'ui',
  'packages/workflow',
  'packages/claude-session',
] as const

/**
 * Resolve the workspace-relative package directories a linked worktree
 * should share `node_modules` symlinks for.
 *
 * Reads `pnpm-workspace.yaml` at `worktreeRoot` — the checked-out copy for
 * THIS branch, in case the branch itself adds, renames, or removes a
 * workspace package — and expands its `packages` globs. Only the pattern
 * shapes actually used by this repo are supported: a literal directory
 * (`orchestrator`) and a single trailing `/*` glob (`packages/*`, expanded
 * via `readdir`). Negated patterns (`!...`) are ignored rather than
 * supported, since none are in use today.
 *
 * Falls back to {@link FALLBACK_DEPENDENCY_WORKSPACES} when the file is
 * missing, unparseable, or resolves to no packages at all — this keeps
 * `provisionWorktreeDeps` working for repos without a committed pnpm
 * workspace.
 *
 * @internal Exported for unit-testing; not part of the module's public API.
 */
export const resolveDependencyWorkspaces = async (
  worktreeRoot: string,
): Promise<readonly string[]> => {
  let raw: string
  try {
    raw = await readFile(resolve(worktreeRoot, 'pnpm-workspace.yaml'), 'utf8')
  } catch {
    return FALLBACK_DEPENDENCY_WORKSPACES
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return FALLBACK_DEPENDENCY_WORKSPACES
  }

  const packagesField =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).packages
      : undefined
  const patterns = Array.isArray(packagesField)
    ? packagesField.filter((p): p is string => typeof p === 'string')
    : null
  if (patterns === null || patterns.length === 0) return FALLBACK_DEPENDENCY_WORKSPACES

  const resolved: string[] = []
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue // negation glob — not supported, skip
    if (pattern.endsWith('/*')) {
      const dir = pattern.slice(0, -2)
      let entries: string[]
      try {
        entries = await readdir(resolve(worktreeRoot, dir))
      } catch {
        continue
      }
      for (const entry of entries) {
        try {
          const st = await lstat(resolve(worktreeRoot, dir, entry))
          if (st.isDirectory()) resolved.push(`${dir}/${entry}`)
        } catch {
          // Unreadable entry — skip it rather than fail the whole resolution.
        }
      }
      continue
    }
    resolved.push(pattern)
  }
  return resolved.length > 0 ? resolved : FALLBACK_DEPENDENCY_WORKSPACES
}

export interface ProvisionWorktreeDepsArgs {
  worktreeRoot: string
  /** The checkout whose installed dependencies a linked worktree reuses. */
  sourceRoot?: string
}

/**
 * Give a linked Mars worktree access to the dependency trees already installed
 * in its source checkout. Git deliberately excludes node_modules, so a
 * worktree re-created outside setup otherwise looks like it has TypeScript
 * defects even though its branch is sound.
 *
 * An existing real directory is left alone: it may be a deliberately isolated
 * install. Existing links are repaired only when they point somewhere else or
 * have gone stale, making the operation safe to call at every worktree entry.
 */
export const provisionWorktreeDeps = async ({
  worktreeRoot,
  sourceRoot,
}: ProvisionWorktreeDepsArgs): Promise<void> => {
  const resolvedSource =
    sourceRoot ?? (await resolveVcs().repoRoot({ cwd: process.cwd() })) ?? process.cwd()
  const workspaces = await resolveDependencyWorkspaces(worktreeRoot)
  for (const workspace of workspaces) {
    const source = resolve(resolvedSource, workspace, 'node_modules')
    const target = resolve(worktreeRoot, workspace, 'node_modules')

    try {
      await lstat(source)
    } catch {
      // Mars can orchestrate repos that do not have this framework layout.
      continue
    }

    try {
      const targetStat = await lstat(target)
      if (!targetStat.isSymbolicLink()) continue
      const linkedTo = await readlink(target)
      const resolvedLink = resolve(resolve(target, '..'), linkedTo)
      if (resolvedLink === source) continue
      await rm(target, { force: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    await mkdir(resolve(target, '..'), { recursive: true })
    await symlink(source, target, 'dir')
  }
}

/**
 * Remove top-level entries from `nmDir` that are symlinks whose arithmetic
 * (non-realpath) resolved path starts with `worktreePath`.
 *
 * Returns the count of removed entries.
 *
 * Background: when pnpm is invoked in a worktree directory whose
 * `node_modules` is a symlink to the parent repo's `node_modules`,
 * it creates top-level package symlinks in the PARENT's `node_modules/`
 * with relative targets that pass through the worktree's symlink.
 * Those targets become dangling the moment the worktree is removed.
 * This function finds and removes those cross-worktree entries so that a
 * subsequent `pnpm install` in the parent can recreate correct, direct links.
 */
export const removeStaleWorktreeLinks = async (
  nmDir: string,
  worktreePath: string,
): Promise<number> => {
  let entries: string[]
  try {
    entries = await readdir(nmDir)
  } catch {
    return 0
  }

  const prefix = worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`
  let removed = 0

  for (const entry of entries) {
    const entryPath = resolve(nmDir, entry)
    try {
      const st = await lstat(entryPath)
      if (!st.isSymbolicLink()) continue
      const raw = await readlink(entryPath)
      // Arithmetic resolution — does NOT follow symlinks. The raw value is
      // resolved relative to the directory containing the symlink (nmDir).
      const arithmeticTarget = resolve(nmDir, raw)
      if (arithmeticTarget.startsWith(prefix)) {
        await rm(entryPath, { force: true })
        removed++
      }
    } catch {
      // Best-effort: skip entries we cannot read or remove.
    }
  }
  return removed
}

/**
 * Before a worktree at `worktreePath` is physically removed, clean up any
 * cross-worktree symlinks it may have left in the parent repo's
 * `node_modules/` directories, then attempt a `pnpm install --frozen-lockfile`
 * in each affected workspace so the parent's package tree is self-contained
 * before the worktree (and its `node_modules` symlink) disappears.
 *
 * This is a best-effort operation: failures are caught and logged rather than
 * propagated so they never block worktree removal.
 */
export const repairNodeModulesAfterWorktreeRemoval = async (
  sourceRoot: string,
  worktreePath: string,
  log?: (msg: string) => void,
): Promise<void> => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  const workspaces = await resolveDependencyWorkspaces(worktreePath)
  for (const workspace of workspaces) {
    const nmDir = resolve(sourceRoot, workspace, 'node_modules')
    let removed: number
    try {
      removed = await removeStaleWorktreeLinks(nmDir, worktreePath)
    } catch {
      continue
    }
    if (removed === 0) continue

    const siteDir = resolve(sourceRoot, workspace)
    log?.(
      `[worktree-deps] removed ${removed} cross-worktree symlink(s) from ${nmDir}; ` +
        `running pnpm install in ${siteDir} to restore direct links`,
    )
    try {
      await execFileAsync('pnpm', ['install', '--frozen-lockfile'], {
        cwd: siteDir,
        // 5-minute ceiling so a hung pnpm never holds up worktree cleanup.
        timeout: 5 * 60_000,
      })
      log?.(`[worktree-deps] repair install succeeded in ${siteDir}`)
    } catch (err: unknown) {
      // Non-fatal: the symlinks are removed; pnpm install is best-effort.
      log?.(
        `[worktree-deps] repair install failed in ${siteDir} (best-effort): ${String(err)}`,
      )
    }
  }
}
