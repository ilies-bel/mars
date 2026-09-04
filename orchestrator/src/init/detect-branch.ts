/**
 * Detect the current/default branch of a git repository.
 *
 * Used by `mars init` to auto-configure the integration branch when the repo's
 * default branch is not `main` (e.g. `master`, `develop`). The result is
 * persisted to `.mars/daemon.json` under the `integrationBranch` key so every
 * subsequent dispatch targets the correct branch without the operator having
 * to set `INTEGRATION_BRANCH` manually.
 */
import { spawnSync } from 'node:child_process'

/**
 * Detect the current branch of the git repo at `repoRoot`.
 *
 * Detection order:
 *   1. `git symbolic-ref --short HEAD` (the checked-out branch)
 *   2. `master` existence check via `git show-ref --verify refs/heads/master`
 *   3. `main` existence check (falls back to the built-in default)
 *   4. `null` when the directory is not a git repo or detection fails
 *
 * Returns `null` rather than throwing so `mars init` can degrade gracefully
 * on non-git projects.
 */
export const detectCurrentBranch = (repoRoot: string): string | null => {
  // Primary: the currently checked-out branch name
  const r = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (r.status === 0 && r.stdout.trim().length > 0) {
    return r.stdout.trim()
  }

  // Detached HEAD or no git — probe known default-branch names by ref existence
  for (const name of ['master', 'main']) {
    const probe = spawnSync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${name}`],
      { cwd: repoRoot, timeout: 5_000 },
    )
    if (probe.status === 0) return name
  }

  return null
}
