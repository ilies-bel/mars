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
import { raiseActionQueueItem } from '../lib/action-queue'
import type { ActionQueueKind } from '../lib/action-queue-kinds'

export const DAEMON_DIED_ACTION_QUEUE_KIND: ActionQueueKind = 'daemon-died'

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
 * If a crash marker file is present, raise a `daemon-died` action-queue item.
 * Returns the item id that was raised (or bumped on re-detection), or `null`
 * when no crash marker exists.
 *
 * Does NOT delete the crash marker — that is the responsibility of `shutdown()`
 * on the next clean exit, so the info is preserved for post-mortem inspection
 * between the crash and the next operator-initiated stop.
 */
export const detectAndRaiseDaemonDied = async (crashMarkerPath: string): Promise<string | null> => {
  const crashInfo = readCrashMarker(crashMarkerPath)
  if (crashInfo === null) return null

  const id = await raiseActionQueueItem({
    kind: DAEMON_DIED_ACTION_QUEUE_KIND,
    category: 'daemon',
    priority: 'high',
    title: 'Daemon exited unexpectedly',
    body: [
      `The daemon (pid ${crashInfo.pid}) exited without a clean shutdown.`,
      `Started:         ${crashInfo.startedAt}`,
      `Crash detected:  ${crashInfo.crashDetectedAt}`,
      '',
      'Recovery:',
      '  • Daemon has already restarted — check `.mars/watch.log` for errors',
      '  • Run `mars list` to review any tasks that may need attention',
      '  • Run `mars restart <id>` to re-run any tasks that were interrupted',
    ].join('\n'),
    payload: {
      pid: crashInfo.pid,
      startedAt: crashInfo.startedAt,
      crashDetectedAt: crashInfo.crashDetectedAt,
    },
    context: {},
    raisedBy: 'daemon:daemon-died-sweep',
    signature: 'daemon-died',
    occurrence: { detectedAt: crashInfo.crashDetectedAt },
  })

  return id
}
