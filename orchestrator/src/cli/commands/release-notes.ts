/**
 * `release-notes` command group: `list` (default).
 *
 * `mars release-notes list` (and the bare `mars release-notes` alias) print the
 * reverse-chronological arc-grouped landed-tasks feed from the daemon's
 * `GET /view/release-notes` endpoint. Each arc is rendered as one tab-separated
 * line: landedAt, shortId (8 chars), recoveryCount, title.
 *
 * If the daemon is not running, both invocations exit non-zero with a clear
 * message — there is no fallback to the raw DB path.
 */

import type { Command } from '../command'
import { readDaemonPort } from './shared'
import type { ReleaseNoteEntry } from '../../core/daemon/view/release-notes'

const NO_DAEMON_MSG =
  'release-notes: daemon not running — run `mars daemon start` (release notes are served by the daemon)'

/**
 * Fetch the release-notes feed from the daemon's derived-view endpoint.
 * Throws when the daemon is unreachable or returns a non-2xx response.
 */
export const fetchReleaseNotes = async (port: number): Promise<ReleaseNoteEntry[]> => {
  const res = await fetch(`http://127.0.0.1:${port}/view/release-notes`)
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as ReleaseNoteEntry[]
}

const releaseNotesList: Command = {
  path: 'release-notes list',
  summary: 'list landed tasks as a reverse-chronological release-notes feed',
  usage: 'usage: mars release-notes list',
  run: async (_args, deps) => {
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let entries: ReleaseNoteEntry[]
    try {
      entries = await fetchReleaseNotes(port)
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    if (entries.length === 0) {
      deps.out('release notes empty')
      return { code: 0 }
    }
    for (const entry of entries) {
      deps.out(
        `${entry.landedAt}\t${entry.originId.slice(0, 8)}\t${entry.detail.recoveryCount}\t${entry.title}`,
      )
    }
    return { code: 0 }
  },
}

const releaseNotesDefault: Command = {
  path: 'release-notes',
  summary: 'list release notes (alias for `release-notes list`)',
  usage: 'usage: mars release-notes [list]',
  run: (args, deps) => releaseNotesList.run(args, deps),
}

export const releaseNotesCommands: readonly Command[] = [
  releaseNotesList,
  releaseNotesDefault,
]
