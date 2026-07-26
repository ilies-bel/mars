/**
 * Mars Release-Notes Watch TUI — what `mars release-notes watch` renders.
 *
 * Connects to the Mars daemon HTTP API. Initial state comes from
 * GET /view/release-notes and GET /view/release-notes-cursor. The view
 * stays live over the daemon's SSE channel at GET /view/stream: on each
 * 'tasks' or 'release-notes' event both endpoints are re-fetched.
 * A reconnect loop survives daemon restarts without killing the TUI.
 *
 * Each arc entry is rendered as one line: landedAt, short originId (8 chars),
 * recoveryCount, and title. Entries newer than lastViewedAt (or all entries
 * when cursor is null) are rendered bold with a leading bullet; already-viewed
 * entries render dimmed.
 *
 * Keybindings:
 *   v        POST /view/release-notes-cursor then re-fetch — marks all seen
 *   q / ^C   exit cleanly via useApp().exit()
 */

import React, { useEffect, useState } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'
import type { ReleaseNoteEntry } from '../core/daemon/view/release-notes'
import { resolveDaemonBaseUrl } from './action-queue-watch'

const NO_DAEMON_MSG =
  'release-notes: daemon not running — run `mars daemon start` (release notes are served by the daemon)'

// ─── pure helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true when an entry has not been seen by the operator.
 *
 * An entry is unseen when:
 *   - lastViewedAt is null (cursor never set → everything is new), OR
 *   - entry.landedAt > lastViewedAt (landed after the last view).
 *
 * Exported so the rendering predicate is independently testable.
 */
export const isUnseen = (
  entry: Pick<ReleaseNoteEntry, 'landedAt'>,
  lastViewedAt: string | null,
): boolean => lastViewedAt === null || entry.landedAt > lastViewedAt

// ─── component ────────────────────────────────────────────────────────────────

interface ReleaseNotesWatchProps {
  baseUrl: string
}

const ReleaseNotesWatch: React.FC<ReleaseNotesWatchProps> = ({ baseUrl }) => {
  const { exit } = useApp()

  const [entries, setEntries] = useState<ReleaseNoteEntry[]>([])
  const [lastViewedAt, setLastViewedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)

  // ── data fetching ───────────────────────────────────────────────────────────

  const refetch = async (): Promise<void> => {
    try {
      const [entriesRes, cursorRes] = await Promise.all([
        fetch(`${baseUrl}/view/release-notes`),
        fetch(`${baseUrl}/view/release-notes-cursor`),
      ])
      if (!entriesRes.ok) throw new Error(`GET /view/release-notes: HTTP ${entriesRes.status}`)
      if (!cursorRes.ok)
        throw new Error(`GET /view/release-notes-cursor: HTTP ${cursorRes.status}`)
      const fetchedEntries = (await entriesRes.json()) as ReleaseNoteEntry[]
      const { lastViewedAt: fetchedCursor } = (await cursorRes.json()) as {
        lastViewedAt: string | null
      }
      setEntries(fetchedEntries)
      setLastViewedAt(fetchedCursor)
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Initial fetch on mount + SSE reconnect loop.
  useEffect(() => {
    void refetch()

    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = async (): Promise<void> => {
      if (cancelled) return
      try {
        const res = await fetch(`${baseUrl}/view/stream`)
        if (!res.ok || !res.body) {
          setLive(false)
          if (!cancelled) reconnectTimer = setTimeout(() => void connect(), 2000)
          return
        }
        setLive(true)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const frames = buf.split('\n\n')
          buf = frames.pop() ?? ''
          for (const frame of frames) {
            if (cancelled) break
            // Extract the event name from the SSE frame.
            const eventMatch = frame.match(/^event:\s*(\S+)/m)
            const name = eventMatch?.[1] ?? ''
            if (name === 'tasks' || name === 'release-notes') {
              void refetch()
            }
          }
        }
      } catch {
        // Absorb abort/network errors; fall through to reconnect.
      }
      if (!cancelled) {
        setLive(false)
        reconnectTimer = setTimeout(() => void connect(), 2000)
      }
    }

    void connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl])

  // ── keybindings ─────────────────────────────────────────────────────────────

  useInput((input, key) => {
    if (input === 'v') {
      void fetch(`${baseUrl}/view/release-notes-cursor`, { method: 'POST' }).then(() =>
        refetch(),
      )
      return
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit()
    }
  })

  // ── render ──────────────────────────────────────────────────────────────────

  const unseenCount = entries.filter((e) => isUnseen(e, lastViewedAt)).length

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          mars release-notes
        </Text>
        <Text> · </Text>
        <Text color={unseenCount > 0 ? 'yellow' : undefined}>{unseenCount} unseen</Text>
        {live ? <Text dimColor> · live</Text> : <Text dimColor> · connecting…</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {entries.length === 0 && !error ? (
          <Box justifyContent="center" paddingY={1}>
            <Text dimColor>no release notes yet</Text>
          </Box>
        ) : (
          entries.map((entry) => {
            const unseen = isUnseen(entry, lastViewedAt)
            const label = `${entry.landedAt}  ${entry.originId.slice(0, 8)}  fix×${entry.detail.recoveryCount}  ${entry.title}`
            return (
              <Box key={entry.originId}>
                <Text bold={unseen} dimColor={!unseen}>
                  {unseen ? '• ' : '  '}
                  {label}
                </Text>
              </Box>
            )
          })
        )}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">error: {error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>v mark viewed · q quit</Text>
      </Box>
    </Box>
  )
}

// ─── entry point ─────────────────────────────────────────────────────────────

/**
 * Entry point for `mars release-notes watch`. Resolves the daemon base URL
 * from the state directory, exits with code 1 when the daemon is not running,
 * or renders the TUI panel and waits for the user to quit.
 */
export const runReleaseNotesWatch = async ({
  stateDir,
}: {
  stateDir: string
}): Promise<void> => {
  const baseUrl = resolveDaemonBaseUrl(stateDir)
  if (!baseUrl) {
    process.stderr.write(`${NO_DAEMON_MSG}\n`)
    process.exit(1)
  }
  await render(<ReleaseNotesWatch baseUrl={baseUrl} />).waitUntilExit()
}
