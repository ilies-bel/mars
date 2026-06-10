/**
 * Auto-open the Release Notes drawer when arcs have landed since the user last
 * viewed them (per focused project). Runs once per UI session per project —
 * a module-level Set guards against re-triggering on re-renders or SSE
 * invalidations.
 *
 * First-run rule: when `lastViewedAt` is null AND history already exists,
 * silently POST the cursor to establish a baseline WITHOUT auto-opening. Only
 * future landed work (relative to that baseline) should trigger auto-open.
 * Rationale: "things shipped while you were away" only has meaning once a
 * baseline exists.
 */

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReleaseNoteEntry } from './schemas'
import { fetchReleaseNotes, getReleaseNotesCursor, postReleaseNotesViewed } from './api'
import { releaseNotesHash } from './routing'

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
 *   the baseline cursor without auto-opening.
 * - Otherwise counts entries whose `landedAt` is lexicographically greater
 *   than `lastViewedAt` (ISO-8601 strings sort correctly as strings).
 *
 * `entries` must be newest-first (index 0 = most recently landed).
 * The returned `firstUnseenIndex` is the index of the oldest unseen entry
 * (highest index in the array among unseen entries).
 */
export function computeUnseen(
  entries: readonly ReleaseNoteEntry[],
  lastViewedAt: string | null,
): UnseenResult {
  // First-run: no cursor established yet. Return zero so the caller sets a
  // baseline rather than auto-opening a wall of history.
  if (lastViewedAt === null) {
    return { unseenCount: 0, firstUnseenIndex: null }
  }

  let unseenCount = 0
  let firstUnseenIndex: number | null = null

  // Iterate newest-first; track the last (highest-index = oldest) unseen entry.
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.landedAt > lastViewedAt) {
      unseenCount++
      firstUnseenIndex = i // updated on each unseen → ends up at the oldest
    }
  }

  return { unseenCount, firstUnseenIndex }
}

// ── Session-level auto-open guard ─────────────────────────────────────────

/**
 * Tracks which projectIds have already triggered an auto-open this session.
 * Module-level so it survives React re-renders and SSE invalidations.
 */
const autoOpenedProjects = new Set<string>()

/**
 * Exported for tests only — lets test suites reset the module-level guard
 * between test cases.
 * @internal
 */
export const _resetAutoOpenedProjects = (): void => {
  autoOpenedProjects.clear()
}

// ── Hook ──────────────────────────────────────────────────────────────────

/**
 * Run the auto-open check for the given project. Safe to call with null while
 * the focused project is still loading — the effect is a no-op in that case.
 *
 * Mount this inside `FocusedProjectProvider` (e.g. in AppInner).
 */
export const useReleaseNotesAutoOpen = (projectId: string | null): void => {
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
    // FUTURE landed work triggers auto-open. Do not open the drawer.
    if (lastViewedAt === null && entries.length > 0) {
      void postReleaseNotesViewed(projectId).then(() => {
        void qc.invalidateQueries({ queryKey: ['release-notes-cursor', projectId] })
      })
      return
    }

    // Session guard: only auto-open once per project per session.
    if (autoOpenedProjects.has(projectId)) return

    const { unseenCount } = computeUnseen(entries, lastViewedAt)
    if (unseenCount === 0) return

    // Mark this project as auto-opened for this session, then navigate.
    autoOpenedProjects.add(projectId)
    if (typeof window !== 'undefined') {
      window.location.hash = releaseNotesHash()
    }
  }, [projectId, notesQuery.data, cursorQuery.data, qc])
}
