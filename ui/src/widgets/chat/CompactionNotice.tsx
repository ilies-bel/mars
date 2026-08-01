import { useState } from 'react'
import type { ChatSegmentCompaction } from '@/shared/schemas'

export interface CompactionNoticeProps {
  segment: ChatSegmentCompaction
}

/**
 * The "little notification" marking where the idle sweeper compacted history.
 *
 * Deliberately a separator, not a message bubble: compaction is something that
 * happened TO the transcript, not something Mars said in it, and rendering it
 * as a turn would put words in Mars's mouth that no one chose. It reads as one
 * quiet line until clicked, then reveals the summary that now stands in for the
 * elided span — the operator can always find out what was folded away, but
 * never has to scroll past it.
 */
export const CompactionNotice = ({ segment }: CompactionNoticeProps) => {
  const [open, setOpen] = useState(false)
  const refs = [
    ...segment.taskIds,
    ...segment.adrRefs,
    ...segment.glossaryRefs,
    ...segment.artifactRefs,
  ]

  return (
    <div className="flex flex-col gap-2" data-testid="compaction-notice">
      <div
        className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground"
        role="separator"
      >
        <span className="h-px flex-1 bg-border" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded-sm px-1 py-0.5 underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="compaction-notice-toggle"
        >
          {/* The count is the honest headline: it says how much history this one
              line now stands for, which is the only thing the operator needs to
              decide whether to expand it. */}
          {segment.messageCount} messages compacted
          {open ? ' — hide' : ' — show summary'}
        </button>
        <span className="h-px flex-1 bg-border" />
      </div>
      {open && (
        <div
          className="rounded-md border border-border bg-muted/30 px-3 py-2"
          data-testid="compaction-notice-summary"
        >
          <p className="whitespace-pre-wrap font-mono text-[12px] text-foreground">
            {segment.summary}
          </p>
          {refs.length > 0 && (
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              {/* Refs are carried forward across checkpoints precisely so they
                  survive compaction; surfacing them here is what makes the
                  claim "nothing was lost" checkable rather than a promise. */}
              Still referenced: {refs.join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
