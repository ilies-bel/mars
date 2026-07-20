/**
 * Unseen release notes for the chat hero "While you were away" panel.
 *
 * HARD CUT from the old auto-open behaviour: nothing navigates to the
 * release-notes hash automatically anymore. Instead this hook computes the
 * entries that landed since the user's view cursor and, the first time a
 * non-empty unseen set is observed for a project in this UI session,
 * snapshots it and POSTs the cursor baseline — rendering the panel IS the
 * act of seeing. The snapshot keeps the panel visible for the rest of the
 * session even though the cursor has advanced; the next session (no delta)
 * shows nothing.
 *
 * First-run rule (unchanged): when `lastViewedAt` is null AND history
 * already exists, silently POST the cursor to establish a baseline and show
 * nothing. "Things shipped while you were away" only has meaning once a
 * baseline exists.
 */

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReleaseNoteEntry } from './schemas'
import { fetchReleaseNotes, getReleaseNotesCursor, postReleaseNotesViewed } from './api'

// ── Unseen computation (pure, exported for tests) ─────────────────────────

export interface UnseenResult {
  /** Number of entries with landedAt > lastViewedAt. */
  unseenCount: number
  /**
   * Index in the newest-first entries array of the OLDEST unseen entry.
   * null when unseenCount === 0.
   */
  firstUnseenIndex: number | null
}

/**
 * Compute the unseen release-note entries relative to a cursor timestamp.
 *
 * - When `lastViewedAt` is null (first-run, no baseline yet), returns
 *   `{ unseenCount: 0, firstUnseenIndex: null }` — the caller should set
 *   the baseline cursor without surfacing anything.
 * - Otherwise counts entries whose `landedAt` is lexicographically greater
 *   than `lastViewedAt` (ISO-8601 strings sort correctly as strings).
 *
 * `entries` must be newest-first (index 0 = most recently landed).
 */
export function computeUnseen(
  entries: readonly ReleaseNoteEntry[],
  lastViewedAt: string | null,
): UnseenResult {
  if (lastViewedAt === null) {
    return { unseenCount: 0, firstUnseenIndex: null }
  }

  let unseenCount = 0
  let firstUnseenIndex: number | null = null

  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.landedAt > lastViewedAt) {
      unseenCount++
      firstUnseenIndex = i // updated on each unseen → ends up at the oldest
    }
  }

  return { unseenCount, firstUnseenIndex }
}

// ── Session-level state ───────────────────────────────────────────────────

/**
 * Per-project snapshot of the unseen entries captured the first time a
 * non-empty unseen set was observed this session. Module-level so the panel
 * survives the cursor POST (which makes the live computation go to zero).
 */
const unseenSnapshots = new Map<string, ReleaseNoteEntry[]>()

/** ProjectIds whose cursor has already been POSTed this session. */
const cursorPostedProjects = new Set<string>()

/**
 * Exported for tests only — resets the module-level session state.
 * @internal
 */
export const _resetUnseenSession = (): void => {
  unseenSnapshots.clear()
  cursorPostedProjects.clear()
}

// ── Hook ──────────────────────────────────────────────────────────────────

export interface UnseenReleaseNotes {
  /** Newest-first unseen entries snapshotted for this session (empty = no panel). */
  unseenEntries: ReleaseNoteEntry[]
}

/**
 * Compute-and-mark-seen hook backing the "While you were away" panel.
 *
 * Mount this ONLY where rendering equals seeing (the chat hero) — mounting
 * it POSTs the view cursor as soon as a non-empty unseen set is observed.
 * Safe to call with null while the focused project is still loading.
 */
export const useUnseenReleaseNotes = (projectId: string | null): UnseenReleaseNotes => {
  const qc = useQueryClient()

  const notesQuery = useQuery({
    queryKey: ['release-notes', projectId],
    queryFn: () => fetchReleaseNotes(projectId ?? undefined),
    enabled: projectId !== null,
  })

  const cursorQuery = useQuery({
    queryKey: ['release-notes-cursor', projectId],
    queryFn: () => getReleaseNotesCursor(projectId ?? undefined),
    enabled: projectId !== null,
  })

  useEffect(() => {
    if (projectId === null) return
    if (notesQuery.data === undefined || cursorQuery.data === undefined) return

    const entries = notesQuery.data
    const { lastViewedAt } = cursorQuery.data

    // First-run: no cursor established. Set the baseline silently so only
    // FUTURE landed work surfaces. Show nothing.
    if (lastViewedAt === null) {
      if (entries.length === 0 || cursorPostedProjects.has(projectId)) return
      cursorPostedProjects.add(projectId)
      void postReleaseNotesViewed(projectId).then(() => {
        void qc.invalidateQueries({ queryKey: ['release-notes-cursor', projectId] })
      })
      return
    }

    const { unseenCount } = computeUnseen(entries, lastViewedAt)
    if (unseenCount === 0 || unseenSnapshots.has(projectId)) return

    // Snapshot the unseen set for the session, then mark it seen: the panel
    // being rendered is the act of viewing.
    unseenSnapshots.set(
      projectId,
      entries.filter((e) => e.landedAt > lastViewedAt),
    )
    if (!cursorPostedProjects.has(projectId)) {
      cursorPostedProjects.add(projectId)
      void postReleaseNotesViewed(projectId).then(() => {
        void qc.invalidateQueries({ queryKey: ['release-notes-cursor', projectId] })
      })
    }
  }, [projectId, notesQuery.data, cursorQuery.data, qc])

  // Prefer the session snapshot (survives the cursor POST); before the
  // snapshot-writing effect has run, fall back to the live computation so the
  // panel appears on the very first render pass.
  const snapshot = projectId !== null ? unseenSnapshots.get(projectId) : undefined
  if (snapshot !== undefined) return { unseenEntries: snapshot }

  const lastViewedAt = cursorQuery.data?.lastViewedAt ?? null
  const live =
    projectId !== null && notesQuery.data !== undefined && lastViewedAt !== null
      ? notesQuery.data.filter((e) => e.landedAt > lastViewedAt)
      : []
  return { unseenEntries: live }
}
