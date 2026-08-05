import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { repoRoot } from './git/internal'

const WORKTREE_DEPENDENCY_WORKSPACES = ['orchestrator', 'ui'] as const

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
  sourceRoot = repoRoot(),
}: ProvisionWorktreeDepsArgs): Promise<void> => {
  for (const workspace of WORKTREE_DEPENDENCY_WORKSPACES) {
    const source = resolve(sourceRoot, workspace, 'node_modules')
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
