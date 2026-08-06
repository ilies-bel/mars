export interface MainThreadRowProps {
  /** True when the main thread is what the reading pane is showing. */
  isSelected: boolean
  onSelect: () => void
  /** Open subthreads, shown as a subordinate count. */
  subthreadCount: number
  /**
   * Total subthreads across the transcript (open + closed).
   * When provided and greater than subthreadCount, both counts are surfaced
   * so the label accurately describes what the transcript renders.
   */
  totalSubthreadCount?: number
}

/**
 * The main thread's entry in the sidebar.
 *
 * The operator asked for the main thread to be "clearly visible compared to the
 * other threads", so this is hierarchy rather than a label. Three things carry
 * it, none of which a subthread row has:
 *
 *   - Position: pinned above the list, outside the scroll region, so it never
 *     scrolls away no matter how many subthreads pile up.
 *   - Weight: a filled, bordered block with a larger type size, against the
 *     subthreads' flat single-line rows.
 *   - Framing: it names what it is ("everything, in one place") because the
 *     distinction being drawn is about scope, not about which chat is newer.
 *
 * The subthread count is deliberately shown HERE rather than on the subthread
 * header: it is the one number that says what the main thread contains, which
 * is the whole reason it outranks them.
 */
export const MainThreadRow = ({
  isSelected,
  onSelect,
  subthreadCount,
  totalSubthreadCount,
}: MainThreadRowProps) => {
  const showBothCounts =
    totalSubthreadCount != null && totalSubthreadCount > subthreadCount

  const subtitle =
    subthreadCount === 0
      ? 'Everything, in one place'
      : showBothCounts
        ? `Everything, in one place · ${subthreadCount} open · ${totalSubthreadCount} total`
        : `Everything, in one place · ${subthreadCount} subthread${subthreadCount === 1 ? '' : 's'}`

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isSelected ? 'true' : undefined}
      aria-label="Main thread"
      data-testid="main-thread-row"
      data-selected={isSelected ? 'true' : 'false'}
      className={[
        'w-full rounded-md border px-2 py-2 text-left transition-colors',
        isSelected
          ? 'border-primary/60 bg-primary/25 text-foreground'
          : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 hover:text-foreground',
      ].join(' ')}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="text-[12px]">◆</span>
        <span className="font-mono text-[12px] font-semibold tracking-wide">Main thread</span>
      </span>
      <span className="mt-0.5 block font-mono text-[9px] text-muted-foreground">
        {subtitle}
      </span>
    </button>
  )
}
