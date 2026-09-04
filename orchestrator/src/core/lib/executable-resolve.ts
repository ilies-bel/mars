/**
 * PATH-search utilities for locating executables on the host filesystem.
 *
 * `FALLBACK_CLAUDE_PATH_DIRS` is the POSIX-only search path consulted when the
 * daemon's inherited PATH is stripped (e.g. detached / launchd contexts). It is
 * shared by both the provider-binary resolver (`workers/provider-bin.ts`) and
 * the git-binary resolver (`lib/git/internal.ts`).
 *
 * `isExecutableFile` is a synchronous executability check used by both resolvers
 * during their directory-scan loops.
 *
 * Previously these lived in `lib/git/internal`, which re-exports them for
 * back-compat. New callers should import directly from this module.
 */

import { statSync, constants as fsConstants, accessSync } from 'node:fs'

// Default search path for the `claude` binary when it is not on the daemon's
// PATH (e.g. detached / launchd contexts strip everything but a minimal PATH).
// Only consulted on POSIX — Windows users install claude.exe via the Windows
// installer which places it on PATH; there are no equivalent well-known
// fallback directories on Windows. Shared by both the claude- and git-binary
// resolvers.
export const FALLBACK_CLAUDE_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

export const isExecutableFile = (path: string): boolean => {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}
