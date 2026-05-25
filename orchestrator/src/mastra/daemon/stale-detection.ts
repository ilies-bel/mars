import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stale-daemon detection and operator-facing error rewriting.
 *
 * Long-lived daemons can outlive a schema rename: e.g. the ideas->proposals
 * table rename in `proposals.ts` lands on disk and any fresh CLI sees the
 * new shape, but a daemon started before the rename is still in memory with
 * code that references the legacy `ideas` table. The first proposal-touching
 * RPC against the migrated DB throws `SQLITE_ERROR: no such table: ideas`
 * (or, symmetrically, a daemon running the new code against a yet-to-migrate
 * DB throws `no such table: proposals`).
 *
 * The two defences here cover both ends of that hand-off:
 *
 * - Source-stamp guard (primary): the daemon captures `proposals.ts`'s mtime
 *   at startup and refuses proposal-mutating RPCs the moment it sees a newer
 *   file on disk, surfacing the restart hint *before* SQLite is touched.
 *   This catches the next rename automatically; it doesn't help a daemon
 *   that predates this guard itself.
 *
 * - Error-message rewrite (fallback): the CLI rewrites
 *   `no such table: ideas|proposals` SQLite errors coming back from any
 *   un-stamped daemon into the same actionable restart hint, so operators
 *   are never left staring at the raw libsql message.
 */

const STALE_TABLE_RE = /no such table:\s*(ideas|proposals)\b/i

export const STALE_DAEMON_HINT =
  'orchestrator daemon appears to be running stale code ' +
  '(the running daemon and the on-disk source disagree about the proposals/ideas table). ' +
  'Restart the daemon: `mars daemon restart`, then retry.'

/**
 * Rewrite a raw daemon-returned error string so a stale-table SQLite failure
 * becomes an actionable restart hint. Non-matching errors pass through
 * unchanged.
 */
export const mapDaemonError = (raw: string): string => {
  if (!raw) return raw
  if (STALE_TABLE_RE.test(raw)) {
    return `${STALE_DAEMON_HINT} (underlying error: ${raw})`
  }
  return raw
}

export interface DaemonSourceStamp {
  /** Absolute path of the watched source file. */
  path: string
  /**
   * mtime of the file at stamp time, in ms. `null` when the file isn't on
   * disk (e.g. compiled-binary distributions); in that case the source-stamp
   * guard is a no-op and we fall back to the error-rewrite path.
   */
  mtimeMs: number | null
}

const proposalsSourcePath = (): string => {
  const here = dirname(fileURLToPath(import.meta.url))
  // server.ts/stale-detection.ts both live under src/mastra/daemon/; proposals.ts
  // is the sibling directory's file at src/mastra/proposals.ts.
  return resolve(here, '..', 'proposals.ts')
}

/**
 * Capture the on-disk mtime of `proposals.ts` for the running daemon to
 * remember. Tolerant of a missing file — returns mtimeMs=null, which makes
 * `isProposalsSourceNewerThan` a no-op.
 */
export const captureProposalsStamp = (
  path: string = proposalsSourcePath(),
): DaemonSourceStamp => {
  try {
    const st = statSync(path)
    return { path, mtimeMs: st.mtimeMs }
  } catch {
    return { path, mtimeMs: null }
  }
}

/**
 * True if the source file referenced by `stamp` is newer on disk than the
 * stamp recorded at daemon startup. Returns false when the file is missing
 * or was missing at stamp time (no signal to act on).
 */
export const isProposalsSourceNewerThan = (
  stamp: DaemonSourceStamp,
): boolean => {
  if (stamp.mtimeMs === null) return false
  try {
    const st = statSync(stamp.path)
    return st.mtimeMs > stamp.mtimeMs
  } catch {
    return false
  }
}

/**
 * Throw an operator-facing restart hint if the on-disk proposals source has
 * been updated since the daemon stamped it. No-op when stamping was not
 * possible (compiled binary, etc.) or when the file is unchanged.
 */
export const assertProposalsSourceFresh = (stamp: DaemonSourceStamp): void => {
  if (isProposalsSourceNewerThan(stamp)) {
    throw new Error(STALE_DAEMON_HINT)
  }
}
