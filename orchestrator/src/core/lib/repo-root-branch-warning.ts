import { resolveVcs } from '../ports/vcs/registry'

/**
 * Surface the legitimate-but-risky state where the primary checkout is not
 * the branch task merges target. Git failures are intentionally silent: the
 * caller's normal Git diagnostics remain the source of truth in that case.
 */
export const warnWhenRepoRootDiffersFromIntegration = async (
  repoRoot: string,
  integrationBranch: string,
  warn: (line: string) => void,
): Promise<void> => {
  try {
    const currentBranch = await resolveVcs().currentBranch({ cwd: repoRoot })
    if (currentBranch !== null && currentBranch !== integrationBranch) {
      warn(
        `warning: repo root is on '${currentBranch}'; tasks merge into '${integrationBranch}'`,
      )
    }
  } catch {
    // Best-effort visibility must never prevent a CLI command or daemon boot.
  }
}
