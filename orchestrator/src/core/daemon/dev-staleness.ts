import { execProbe, resolveGitBin } from '../lib/git/internal'

/** Paths whose committed contents can alter daemon behaviour after startup. */
const DAEMON_CODE_PATHS = ['orchestrator/src', 'packages/workflow', '.mars/workflows']

/**
 * Return true when the daemon's running source has drifted from the current
 * HEAD, i.e. when all of the following hold:
 *
 * - installRoute is 'dev' (prod binaries are handled by self-update.ts)
 * - sourceSha is non-null  (captured successfully at startup)
 * - currentSha is non-null (captured successfully just now)
 * - sourceSha !== currentSha  (HEAD has advanced since startup)
 *
 * Any null SHA means the git state is unknown — in that case we return
 * false so we never surface a spurious warning.
 */
export const isStaleDev = (
  sourceSha: string | null,
  currentSha: string | null,
  installRoute: 'dev' | 'prod',
): boolean => {
  if (installRoute !== 'dev') return false
  if (sourceSha === null || currentSha === null) return false
  return sourceSha !== currentSha
}

/**
 * Return whether commits since daemon startup changed code or workflows the
 * daemon can execute. Commits outside this set (such as UI auto-commits) do
 * not make an in-memory daemon stale.
 */
export const hasRelevantDevDrift = async (
  sourceSha: string | null,
  currentSha: string | null,
  installRoute: 'dev' | 'prod',
  repoDir: string | null,
): Promise<boolean> => {
  if (!isStaleDev(sourceSha, currentSha, installRoute) || repoDir === null) return false

  const result = await execProbe(
    resolveGitBin(),
    ['diff', '--quiet', `${sourceSha}..${currentSha}`, '--', ...DAEMON_CODE_PATHS],
    { cwd: repoDir },
  )
  return result.exitCode === 1
}
