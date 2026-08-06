/**
 * AwayDigest — renders a persisted away-digest main-thread entry.
 *
 * Displayed when the operator returns after an idle span. The digest is a
 * system-authored narration of what Mars did while they were away; it is
 * composed once, written to `main_thread_entries`, and served from the DB on
 * every reload — bytes-identical, never regenerated.
 *
 * Rendering contract:
 *   - Uses TypedBody so the first appearance reads as speech (simulated typing).
 *   - After the first reveal the text appears instantly (module-level `revealed`
 *     set in TypedBody).
 *   - No interactive controls — the operator can read but cannot act on this
 *     entry directly.
 *   - `prefers-reduced-motion` suppresses the typing animation via TypedBody.
 */

import { TypedBody } from '../widgets/chat/TypedBody'

export interface AwayDigestLine {
  taskId: string
  title: string
  arcShape: 'landed' | 'stumbled-recovered' | 'needs-you'
  text: string
}

export interface AwayDigestCounts {
  landed: number
  'stumbled-recovered': number
  'needs-you': number
}

export interface AwayDigestEntry {
  /** Stable row id from `main_thread_entries` — used as the TypedBody reveal key. */
  id: string
  counts: AwayDigestCounts
  lines: AwayDigestLine[]
}

/** Produce the text that reads as a single speech bubble for this digest. */
function formatDigestText(entry: AwayDigestEntry): string {
  if (entry.lines.length === 0) return 'While you were away, nothing happened.'
  return entry.lines.map((line) => line.text).join('\n')
}

export interface AwayDigestProps {
  entry: AwayDigestEntry
}

/**
 * A main-thread entry that narrates what Mars did while the operator was away.
 * Renders with a simulated typing animation on first appearance; subsequent
 * renders (page reload, tab switch) show the full text immediately.
 */
export const AwayDigest = ({ entry }: AwayDigestProps) => {
  const text = formatDigestText(entry)

  return (
    <article
      data-testid={`away-digest-${entry.id}`}
      data-kind="away_digest"
      className="rounded-md border border-primary/20 bg-primary/5 p-3"
      aria-label="While you were away"
    >
      <header className="mb-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
        <span className="text-primary">Mars</span>
        <span>while you were away</span>
      </header>
      <TypedBody
        id={entry.id}
        text={text}
        className="whitespace-pre-wrap font-mono text-[13px] text-foreground"
      />
    </article>
  )
}
