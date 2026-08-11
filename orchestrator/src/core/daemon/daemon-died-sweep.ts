/**
 * Daemon-died alert: on daemon start, if a stale running marker is found
 * (meaning the previous daemon process did not exit through the clean
 * `shutdown()` path), a `daemon.crash.json` file is written by `startDaemon`
 * and this sweep raises one action-queue item so the operator learns the
 * daemon restarted unexpectedly.
 *
 * The item is signature-keyed on `'daemon-died'` (no origin task), so
 * repeated unclean exits before an acknowledgement bump `seen_count` on the
 * same open row rather than inserting siblings.
 *
 * Cleared when the operator acknowledges it in the action queue.
 */

import { existsSync, readFileSync } from 'node:fs'

export interface DaemonCrashInfo {
  /** PID of the daemon that exited uncleanly. */
  pid: number
  /** ISO timestamp when that daemon process started. */
  startedAt: string
  /** ISO timestamp when the unclean exit was detected (i.e. current startup time). */
  crashDetectedAt: string
}

/**
 * Read and parse the crash marker file. Returns `null` when the file is
 * absent, unreadable, or does not match the expected shape.
 */
export const readCrashMarker = (crashMarkerPath: string): DaemonCrashInfo | null => {
  if (!existsSync(crashMarkerPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(crashMarkerPath, 'utf8'))
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'pid' in parsed &&
      typeof (parsed as Record<string, unknown>).pid === 'number' &&
      'startedAt' in parsed &&
      typeof (parsed as Record<string, unknown>).startedAt === 'string' &&
      'crashDetectedAt' in parsed &&
      typeof (parsed as Record<string, unknown>).crashDetectedAt === 'string'
    ) {
      return parsed as DaemonCrashInfo
    }
    return null
  } catch {
    return null
  }
}

/**
 * No-op: `daemon-died` rows are now derived on read from the crash marker file.
 * The marker is written at startup and read by the derivation layer on every
 * action-queue list.  Kept as a stub so call sites in server.ts compile without change.
 */
export const detectAndRaiseDaemonDied = async (_crashMarkerPath: string): Promise<string | null> => {
  return null
}
