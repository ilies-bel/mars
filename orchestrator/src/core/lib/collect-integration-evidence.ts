import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface IntegratedCommit {
  sha: string
  shortSha: string
  subject: string
  files: string[]
}

export interface IntegrationEvidence {
  commits: IntegratedCommit[]
  touchedFiles: string[]
}

/**
 * Find the commits from `branch` that have been merged into `integrationBranch`,
 * along with the union of files those commits touched.
 *
 * Strategy:
 *  1. Use the branch reflog to find the branch creation point (the commit the
 *     branch was at when it was first created — the last reflog entry).
 *  2. Collect commits from that creation point to the branch tip.
 *  3. Collect commits from that creation point to the integrationBranch tip.
 *  4. Intersect by SHA: the ones in both sets are the task commits that landed.
 *
 * This works correctly for fast-forward-only merges (mars's merge strategy),
 * where the task branch's exact SHAs appear in the integration branch after merging.
 *
 * Returns `{commits: [], touchedFiles: []}` without throwing when:
 *   - the branch does not exist locally
 *   - the branch has 0 commits since its creation point
 *   - no branch commits appear in the integration branch
 */
export const collectIntegrationEvidence = async (
  branch: string,
  integrationBranch: string,
  repoRoot: string,
): Promise<IntegrationEvidence> => {
  try {
    // Step 1: Find the branch creation point via the reflog.
    // `git reflog show --format=%H <branch>` outputs SHAs newest-first.
    // The LAST entry is the SHA the branch pointed to when it was created.
    const { stdout: reflogOut } = await exec(
      'git',
      ['reflog', 'show', '--format=%H', branch],
      { cwd: repoRoot },
    )
    const reflogLines = reflogOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (reflogLines.length === 0) {
      return { commits: [], touchedFiles: [] }
    }
    const branchStart = reflogLines[reflogLines.length - 1]

    // Step 2: Commits on this branch since the creation point.
    const { stdout: branchRevOut } = await exec(
      'git',
      ['rev-list', `${branchStart}..${branch}`],
      { cwd: repoRoot },
    )
    const branchShas = new Set(
      branchRevOut
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
    if (branchShas.size === 0) {
      return { commits: [], touchedFiles: [] }
    }

    // Step 3: Commits on the integration branch since the same creation point.
    const { stdout: integrationRevOut } = await exec(
      'git',
      ['rev-list', `${branchStart}..${integrationBranch}`],
      { cwd: repoRoot },
    )
    const integrationShas = new Set(
      integrationRevOut
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )

    // Step 4: Intersect — commits from the branch that landed in integration.
    const mergedShas = [...branchShas].filter((sha) => integrationShas.has(sha))
    if (mergedShas.length === 0) {
      return { commits: [], touchedFiles: [] }
    }

    // Step 5: Fetch subjects for all merged commits in one call.
    const { stdout: subjectsOut } = await exec(
      'git',
      ['log', '--format=%H%x00%s', '--no-walk', ...mergedShas],
      { cwd: repoRoot },
    )
    const subjectMap = new Map<string, string>()
    for (const line of subjectsOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      const nul = line.indexOf('\x00')
      if (nul !== -1) {
        subjectMap.set(line.slice(0, nul), line.slice(nul + 1))
      }
    }

    // Step 6: Fetch files for each merged commit (diff-tree is reliable and fast).
    const commits: IntegratedCommit[] = []
    const allTouchedFiles = new Set<string>()

    for (const sha of mergedShas) {
      const { stdout: filesOut } = await exec(
        'git',
        ['diff-tree', '--no-commit-id', '-r', '--name-only', sha],
        { cwd: repoRoot },
      )
      const files = filesOut
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      files.forEach((f) => allTouchedFiles.add(f))

      commits.push({
        sha,
        shortSha: sha.slice(0, 7),
        subject: subjectMap.get(sha) ?? '',
        files,
      })
    }

    return { commits, touchedFiles: [...allTouchedFiles] }
  } catch {
    return { commits: [], touchedFiles: [] }
  }
}
