/**
 * `release-notes` command group: `list` (default), `mark-viewed`.
 *
 * `mars release-notes list` (and the bare `mars release-notes` alias) print the
 * reverse-chronological arc-grouped landed-tasks feed from the daemon's
 * `GET /view/release-notes` endpoint. Each arc is rendered as one tab-separated
 * line: landedAt, shortId (8 chars), recoveryCount, title.
 *
 * Flags supported by `list`:
 *   --since <ISO>    only entries with landedAt strictly after the given timestamp
 *   --unseen         only entries newer than the stored cursor (all when cursor is null)
 *   --mark-viewed    after listing, POST the cursor and print "marked viewed at <ISO>"
 *
 * `mars release-notes mark-viewed` posts the cursor without listing.
 *
 * If the daemon is not running, all invocations exit non-zero with a clear
 * message — there is no fallback to the raw DB path.
 */

import type { Command } from '../command'
import { hasFlag } from '../args'
import { readDaemonPort } from './shared'
import type { ReleaseNoteEntry } from '../../core/daemon/view/release-notes'

const NO_DAEMON_MSG =
  'release-notes: daemon not running — run `mars daemon start` (release notes are served by the daemon)'

const LIST_USAGE =
  'usage: mars release-notes list [--since <ISO>] [--unseen] [--mark-viewed]'

/**
 * Fetch the release-notes feed from the daemon's derived-view endpoint.
 * Throws when the daemon is unreachable or returns a non-2xx response.
 */
export const fetchReleaseNotes = async (port: number): Promise<ReleaseNoteEntry[]> => {
  const res = await fetch(`http://127.0.0.1:${port}/view/release-notes`)
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as ReleaseNoteEntry[]
}

/**
 * GET /view/release-notes-cursor — returns the last-viewed timestamp (null when never viewed).
 * Throws when the daemon is unreachable or returns a non-2xx response.
 */
export const fetchReleaseNotesCursor = async (
  port: number,
): Promise<{ lastViewedAt: string | null }> => {
  const res = await fetch(`http://127.0.0.1:${port}/view/release-notes-cursor`)
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as { lastViewedAt: string | null }
}

/**
 * POST /view/release-notes-cursor — stamps now as last-viewed and returns the timestamp.
 * Throws when the daemon is unreachable or returns a non-2xx response.
 */
export const postReleaseNotesCursor = async (
  port: number,
): Promise<{ lastViewedAt: string }> => {
  const res = await fetch(`http://127.0.0.1:${port}/view/release-notes-cursor`, {
    method: 'POST',
  })
  if (!res.ok) throw new Error(`daemon returned ${res.status}`)
  return (await res.json()) as { lastViewedAt: string }
}

const releaseNotesList: Command = {
  path: 'release-notes list',
  summary:
    'list landed tasks as a reverse-chronological release-notes feed [--since <ISO>] [--unseen] [--mark-viewed]',
  usage: LIST_USAGE,
  run: async (args, deps) => {
    const since = args.flags['--since']
    const unseen = hasFlag(args, '--unseen')
    const markViewed = hasFlag(args, '--mark-viewed')

    // --since and --unseen are mutually exclusive
    if (since !== undefined && unseen) {
      deps.err(LIST_USAGE)
      return { code: 2 }
    }

    // Validate --since: must parse as a finite number via Date.parse
    if (since !== undefined && !Number.isFinite(Date.parse(since))) {
      deps.err(LIST_USAGE)
      return { code: 2 }
    }

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

    // Determine the filter threshold
    let threshold: string | null = null
    if (since !== undefined) {
      threshold = since
    } else if (unseen) {
      let cursor: { lastViewedAt: string | null }
      try {
        cursor = await fetchReleaseNotesCursor(port)
      } catch {
        deps.err(NO_DAEMON_MSG)
        return { code: 1 }
      }
      threshold = cursor.lastViewedAt
    }

    let filtered: ReleaseNoteEntry[]
    if (threshold !== null) {
      filtered = entries.filter((e) => e.landedAt > threshold)
    } else {
      filtered = entries
    }

    if (filtered.length === 0) {
      deps.out('release notes empty')
    } else {
      for (const entry of filtered) {
        deps.out(
          `${entry.landedAt}\t${entry.originId.slice(0, 8)}\t${entry.detail.recoveryCount}\t${entry.title}`,
        )
      }
    }

    if (markViewed) {
      let result: { lastViewedAt: string }
      try {
        result = await postReleaseNotesCursor(port)
      } catch {
        deps.err(NO_DAEMON_MSG)
        return { code: 1 }
      }
      deps.out(`marked viewed at ${result.lastViewedAt}`)
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

const releaseNotesMarkViewed: Command = {
  path: 'release-notes mark-viewed',
  summary: 'mark release notes as viewed (POSTs the cursor and prints the timestamp)',
  usage: 'usage: mars release-notes mark-viewed',
  run: async (_args, deps) => {
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let result: { lastViewedAt: string }
    try {
      result = await postReleaseNotesCursor(port)
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    deps.out(result.lastViewedAt)
    return { code: 0 }
  },
}

const releaseNotesWatch: Command = {
  path: 'release-notes watch',
  summary: 'watch release notes live (interactive TUI)',
  usage: 'usage: mars release-notes watch',
  run: async (_args, deps) => {
    const { runReleaseNotesWatch } = await import('../release-notes-watch')
    await runReleaseNotesWatch({ stateDir: deps.ctx.stateDir })
    return { code: 0 }
  },
}

export const releaseNotesCommands: readonly Command[] = [
  releaseNotesList,
  releaseNotesDefault,
  releaseNotesMarkViewed,
  releaseNotesWatch,
]
