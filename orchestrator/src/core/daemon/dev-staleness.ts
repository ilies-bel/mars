import { execProbe, resolveGitBin } from '../lib/git/internal'

/** Paths whose committed contents can alter daemon behaviour after startup. */
const DAEMON_CODE_PATHS = ['orchestrator/src', 'packages/workflow', '.mars/workflows']
const DEPENDENCY_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'orchestrator/package.json',
  'orchestrator/package-lock.json',
]

export type DevStalenessAction = 'none' | 'nudge' | 'restart'

/** Inputs used to decide how a dev daemon should react to relevant HEAD drift. */
export type DevStalenessDecisionInput = {
  sourceSha: string | null
  currentSha: string | null
  installRoute: 'dev' | 'prod'
  inFlightCount: number
  dependencyDrift: boolean
  stabilityCount: number
  autoRestartEnabled: boolean
}

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
 * Decide whether relevant local HEAD drift needs an operator nudge or can
 * safely restart this daemon. Call only after {@link hasRelevantDevDrift}
 * reports true; this policy intentionally does not inspect git itself.
 */
export const decideDevStalenessAction = ({
  sourceSha,
  currentSha,
  installRoute,
  inFlightCount,
  dependencyDrift,
  stabilityCount,
  autoRestartEnabled,
}: DevStalenessDecisionInput): DevStalenessAction => {
  if (!isStaleDev(sourceSha, currentSha, installRoute)) return 'none'
  if (!autoRestartEnabled || dependencyDrift || inFlightCount > 0) return 'nudge'
  return stabilityCount >= 2 ? 'restart' : 'none'
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
  if (
    !isStaleDev(sourceSha, currentSha, installRoute) ||
    sourceSha === null ||
    currentSha === null ||
    repoDir === null
  ) {
    return false
  }

  return hasChangedPaths(sourceSha, currentSha, repoDir, DAEMON_CODE_PATHS)
}

/**
 * Return whether local dependency manifests changed since the daemon started.
 * A restart alone cannot load those changes, so they require an operator nudge.
 */
export const hasDevDependencyDrift = async (
  sourceSha: string | null,
  currentSha: string | null,
  repoDir: string | null,
): Promise<boolean> => {
  if (sourceSha === null || currentSha === null || sourceSha === currentSha || repoDir === null) {
    return false
  }

  return hasChangedPaths(sourceSha, currentSha, repoDir, DEPENDENCY_PATHS)
}

const hasChangedPaths = async (
  sourceSha: string,
  currentSha: string,
  repoDir: string,
  paths: string[],
): Promise<boolean> => {
  const result = await execProbe(
    resolveGitBin(),
    ['diff', '--quiet', `${sourceSha}..${currentSha}`, '--', ...paths],
    { cwd: repoDir },
  )
  return result.exitCode === 1
}
