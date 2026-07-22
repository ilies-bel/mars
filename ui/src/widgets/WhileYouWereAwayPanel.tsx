/**
 * "While you were away" — the chat hero summary of release notes and
 * auto-executed learned recipes that fired since the user's last visit.
 *
 * Rendering this panel is the act of viewing: the backing hook
 * (`useUnseenReleaseNotes`) POSTs the view cursor when a non-empty unseen set
 * is first observed, so the next visit with no delta shows nothing. The
 * ReleaseNotesModal remains available manually via its hash route — the small
 * "Release notes" link here points at it.
 */

import { useQuery } from '@tanstack/react-query'
import type { AutoRecipeRun, ReleaseNoteEntry } from '@/shared/schemas'
import { fetchAutoRecipeRuns, getReleaseNotesCursor } from '@/shared/api'
import { useUnseenReleaseNotes } from '@/shared/useUnseenReleaseNotes'
import { releaseNotesHash } from '@/shared/routing'

/** Maximum entries listed before collapsing into "and N more". */
export const MAX_VISIBLE_ENTRIES = 8

/** First line of the arc prompt, trimmed to a one-liner. */
export const entryOneLiner = (entry: ReleaseNoteEntry): string => {
  const firstLine = entry.detail.prompt.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine
}

/** Short human-readable description of an auto-recipe run. */
export const autoRunLabel = (run: AutoRecipeRun): string => {
  const task = run.taskId ? ` on ${run.taskId}` : ''
  return `Auto-${run.actionOp}${task} (${run.signature})`
}

export interface WhileYouWereAwayPanelProps {
  projectId: string | null
}

export const WhileYouWereAwayPanel = ({ projectId }: WhileYouWereAwayPanelProps) => {
  const { unseenEntries } = useUnseenReleaseNotes(projectId)

  // Fetch the release-notes cursor so we know the "since" timestamp for
  // auto-recipe runs. The cursor marks when the user last viewed the panel.
  const { data: cursor } = useQuery({
    queryKey: ['release-notes-cursor', projectId],
    queryFn: () => getReleaseNotesCursor(projectId ?? undefined),
    enabled: projectId !== null,
    staleTime: 30_000,
  })

  // Auto-recipe runs since the last-viewed cursor.
  const { data: autoRuns = [] } = useQuery({
    queryKey: ['auto-recipe-runs', cursor?.lastViewedAt],
    queryFn: () =>
      fetchAutoRecipeRuns({
        since: cursor?.lastViewedAt ?? undefined,
        limit: 20,
      }),
    enabled: projectId !== null,
    staleTime: 30_000,
  })

  if (unseenEntries.length === 0 && autoRuns.length === 0) return null

  const visible = unseenEntries.slice(0, MAX_VISIBLE_ENTRIES)
  const overflow = unseenEntries.length - visible.length

  return (
    <section
      data-testid="while-you-were-away"
      className="w-full max-w-xl rounded-xl border border-iron/20 bg-surface px-5 py-4 text-left"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-mono text-[13px] font-bold uppercase tracking-wide text-fg">
          While you were away
        </h2>
        <a
          href={releaseNotesHash()}
          data-testid="release-notes-link"
          className="font-mono text-[11px] text-iron/60 underline underline-offset-2 hover:text-fg"
        >
          Release notes
        </a>
      </div>
      {visible.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {visible.map((entry) => (
            <li key={entry.originId} data-testid="wywa-entry">
              <span className="font-mono text-[13px] font-semibold text-fg">{entry.title}</span>
              {entryOneLiner(entry) !== '' && (
                <span className="ml-2 font-mono text-[12px] text-iron/60">
                  {entryOneLiner(entry)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {overflow > 0 && (
        <p data-testid="wywa-overflow" className="mt-2 font-mono text-[12px] text-iron/50">
          and {overflow} more
        </p>
      )}
      {autoRuns.length > 0 && (
        <div className="mt-4" data-testid="wywa-auto-runs">
          <p className="font-mono text-[10px] uppercase tracking-wider text-iron">
            Auto-applied
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {autoRuns.map((run) => (
              <li key={run.id} data-testid="wywa-auto-run" className="font-mono text-[12px] text-fg/80">
                {autoRunLabel(run)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
