/**
 * Staleness comparison for the dev-install daemon. A daemon started on
 * commit A is "stale" once main advances to commit B — it keeps running
 * the old in-memory code with no indication to the operator.
 *
 * This is a pure comparison; the git I/O lives in server.ts so the
 * function remains synchronous and trivially testable.
 */

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
