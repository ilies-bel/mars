import { execFileSync } from 'node:child_process'
import { resolveGitBin } from './git/internal'

/**
 * Surface the legitimate-but-risky state where the primary checkout is not
 * the branch task merges target. Git failures are intentionally silent: the
 * caller's normal Git diagnostics remain the source of truth in that case.
 */
export const warnWhenRepoRootDiffersFromIntegration = (
  repoRoot: string,
  integrationBranch: string,
  warn: (line: string) => void,
): void => {
  try {
    const stdout = execFileSync(
      resolveGitBin(),
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    const currentBranch = stdout.trim()
    if (currentBranch !== '' && currentBranch !== integrationBranch) {
      warn(
        `warning: repo root is on '${currentBranch}'; tasks merge into '${integrationBranch}'`,
      )
    }
  } catch {
    // Best-effort visibility must never prevent a CLI command or daemon boot.
  }
}
