/**
 * "While you were away" — the chat hero summary of activity since the user's
 * last visit. Fetches a unified delta from the daemon covering: merges landed,
 * tasks failed and recovered, auto-applied recipes, throttle/rate-limit events,
 * and evaporated idle threads. Each item renders as a plain-English one-liner.
 *
 * The backing hook (`useUnseenReleaseNotes`) POSTs the view cursor when a
 * non-empty unseen set is first observed so the next visit shows nothing. The
 * ReleaseNotesModal is still reachable via the "Release notes" link in the
 * header.
 *
 * A session-level snapshot ensures events keep appearing even after the cursor
 * is refreshed by the backing hook's POST — without it the delta would re-fetch
 * with `since=now` and immediately return empty.
 */

import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ReleaseNoteEntry, WywaDeltaResponse } from '@/shared/schemas'
import { fetchWywaDelta, getReleaseNotesCursor } from '@/shared/api'
import { useUnseenReleaseNotes } from '@/shared/useUnseenReleaseNotes'
import { releaseNotesHash } from '@/shared/routing'
import { StewardLedgerPanel } from './StewardLedgerPanel'

/** Maximum delta events listed before collapsing into "and N more". */
export const MAX_VISIBLE_ENTRIES = 8

/** First line of the arc prompt, trimmed to a one-liner (kept for callers). */
export const entryOneLiner = (entry: ReleaseNoteEntry): string => {
  const firstLine = entry.detail.prompt.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine
}

export interface WhileYouWereAwayPanelProps {
  projectId: string | null
}

export const WhileYouWereAwayPanel = ({ projectId }: WhileYouWereAwayPanelProps) => {
  // Side effect: POSTs the cursor when unseen release notes are detected. This
  // hooks the panel into the "mark as viewed" lifecycle without duplicating it.
  const { unseenEntries } = useUnseenReleaseNotes(projectId)

  // Fetch the release-notes cursor to derive the `since` lower bound for the
  // delta query. The cursor is the ISO-8601 timestamp of the last panel view.
  const { data: cursor } = useQuery({
    queryKey: ['release-notes-cursor', projectId],
    queryFn: () => getReleaseNotesCursor(projectId ?? undefined),
    enabled: projectId !== null,
    staleTime: 30_000,
  })

  // Unified delta: all activity since the cursor.
  const { data: freshDelta } = useQuery({
    queryKey: ['wywa-delta', projectId, cursor?.lastViewedAt],
    queryFn: () =>
      fetchWywaDelta({
        since: cursor?.lastViewedAt ?? undefined,
        limit: MAX_VISIBLE_ENTRIES + 1, // fetch one extra to detect overflow
      }),
    enabled: projectId !== null && cursor !== undefined,
    staleTime: 30_000,
  })

  // Session-level snapshot: once we have non-empty events, keep showing them
  // even after the cursor is refreshed to "now" by the hook's POST. Without
  // this, the delta re-fetches with since=now → empty, causing a flicker.
  const snapshotRef = useRef<WywaDeltaResponse | null>(null)
  if (snapshotRef.current === null && (freshDelta?.events.length ?? 0) > 0) {
    snapshotRef.current = freshDelta!
  }
  const delta = snapshotRef.current ?? freshDelta

  const events = delta?.events ?? []
  const andMore = delta?.andMore ?? 0

  if (unseenEntries.length === 0 && events.length === 0) return null

  const visible = events.slice(0, MAX_VISIBLE_ENTRIES)
  const overflow = andMore + Math.max(0, events.length - visible.length)

  return (
    <section
      data-testid="while-you-were-away"
      className="w-full max-w-xl rounded-xl border border-primary/20 bg-card px-5 py-4 text-left"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-mono text-[13px] font-bold uppercase tracking-wide text-foreground">
          While you were away
        </h2>
        <a
          href={releaseNotesHash()}
          data-testid="release-notes-link"
          className="font-mono text-[11px] text-primary/60 underline underline-offset-2 hover:text-foreground"
        >
          Release notes
        </a>
        <a
          href="#steward-ledger"
          data-testid="steward-ledger-link"
          onClick={(event) => {
            event.preventDefault()
            document.getElementById('steward-ledger')?.scrollIntoView({ behavior: 'smooth' })
          }}
          className="font-mono text-[11px] text-primary/60 underline underline-offset-2 hover:text-foreground"
        >
          See timeline
        </a>
      </div>
      {visible.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {visible.map((event, i) => (
            <li
              key={`${event.kind}-${event.at}-${i}`}
              data-testid="wywa-event"
              className="font-mono text-[12px] text-foreground/80"
            >
              {event.summary}
            </li>
          ))}
        </ul>
      )}
      {overflow > 0 && (
        <p data-testid="wywa-overflow" className="mt-2 font-mono text-[12px] text-primary/50">
          and {overflow} more
        </p>
      )}
      <StewardLedgerPanel />
    </section>
  )
}
