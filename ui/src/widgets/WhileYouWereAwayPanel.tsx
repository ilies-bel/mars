/**
 * "While you were away" — the chat hero summary of release notes that landed
 * since the user's last visit.
 *
 * Rendering this panel is the act of viewing: the backing hook
 * (`useUnseenReleaseNotes`) POSTs the view cursor when a non-empty unseen set
 * is first observed, so the next visit with no delta shows nothing. The
 * ReleaseNotesModal remains available manually via its hash route — the small
 * "Release notes" link here points at it.
 */

import type { ReleaseNoteEntry } from '@/shared/schemas'
import { useUnseenReleaseNotes } from '@/shared/useUnseenReleaseNotes'
import { releaseNotesHash } from '@/shared/routing'

/** Maximum entries listed before collapsing into "and N more". */
export const MAX_VISIBLE_ENTRIES = 8

/** First line of the arc prompt, trimmed to a one-liner. */
export const entryOneLiner = (entry: ReleaseNoteEntry): string => {
  const firstLine = entry.detail.prompt.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine
}

export interface WhileYouWereAwayPanelProps {
  projectId: string | null
}

export const WhileYouWereAwayPanel = ({ projectId }: WhileYouWereAwayPanelProps) => {
  const { unseenEntries } = useUnseenReleaseNotes(projectId)

  if (unseenEntries.length === 0) return null

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
      {overflow > 0 && (
        <p data-testid="wywa-overflow" className="mt-2 font-mono text-[12px] text-iron/50">
          and {overflow} more
        </p>
      )}
    </section>
  )
}
