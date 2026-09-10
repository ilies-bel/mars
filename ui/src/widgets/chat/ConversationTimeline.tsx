import { Fragment, useRef, useState } from 'react'
import { ChevronUp } from 'lucide-react'
import type { ChatConversationEntry, PreloadedResponse, SubjectBoundary } from '@/shared/schemas'
import { formatAbsoluteDate, formatAbsoluteDateTime, formatClockTime, localDayKey } from '@/shared/time'
import { formatCompactCount } from '@/shared/displayStrings'
import { MemoryBoundaryLine } from './MemoryBoundaryLine'
import { PreloadedResponses } from './PreloadedResponses'
import { SubjectBoundaryLine } from './SubjectBoundaryLine'
import { TypedBody, markRevealed } from './TypedBody'

export interface ConversationTimelineProps {
  entries: ChatConversationEntry[]
  /** Subject seams and final aggregate token weight from the conversation API. */
  boundaries?: SubjectBoundary[]
  /** The last durable message outside Mars's current readable memory. */
  memoryStartsAfterSeq?: number
  /** The active Subject is rendered by ChatConversation so streamed state has one owner. */
  activeThreadId?: string | null
  projectId?: string
  onResponseComplete?: (threadId?: string) => void
  /** Resolves a `client` target — currently only opening a proposal Subject. */
  onClientResolve?: (response: PreloadedResponse) => void
  /**
   * Height (px) of the composer rendered below or over the scroll container.
   * A spacer of this height is appended after the last entry so the final
   * message is never hidden behind the composer when the list is scrolled to
   * the bottom. Measured and updated via ResizeObserver by the parent so the
   * spacer tracks a growing multi-line textarea automatically.
   */
  composerHeight?: number
  /**
   * When set, the conversation failed to load. Renders an error state instead
   * of a blank timeline so the operator can distinguish "no messages yet" from
   * "messages failed to load". Use the raw thrown value from the fetch error;
   * a description is derived from the error's kind at render time.
   */
  loadError?: unknown
}

/** How many subjects to show on first paint — matches Control Room's steward-timeline cap. */
const INITIAL_SUBJECTS = 20

/** Maps wire enum values to readable labels so raw enums never appear in visible text. */
const ENTRY_KIND_LABELS: Record<string, string> = {
  acknowledgment: 'Reply',
  notice: 'Notice',
  validation: 'Validation',
  situation: 'Situation',
  context_line: 'Context',
  'verify/unclassified': 'Verify',
}
const friendlyKind = (kind: string): string => ENTRY_KIND_LABELS[kind] ?? kind

/**
 * When each turn was said.
 *
 * The transcript carried no clock at all — every message, across every day,
 * sat under one undifferentiated column — so four Situation reports written
 * hours apart, each in the present tense and each claiming a different set of
 * numbers, stacked with nothing to order them by. `ml-auto` pins the time to
 * the far end of the meta row so it reads as a margin note rather than as part
 * of the sentence.
 */
const MessageTime = ({ at }: { at: string }) => (
  <time
    dateTime={at}
    title={formatAbsoluteDateTime(at)}
    data-testid="conversation-message-time"
    className="ml-auto shrink-0 tabular-nums text-muted-foreground/70"
  >
    {formatClockTime(at)}
  </time>
)

/**
 * The seam between two calendar days. A bare "15:50" is only unambiguous
 * inside one day, and this transcript spans as many as the operator has been
 * running Mars.
 */
const DaySeparator = ({ at }: { at: string }) => (
  <div className="flex items-center gap-3 py-1" data-testid="conversation-day-separator">
    <span className="h-px flex-1 bg-border" />
    <span className="shrink-0 text-micro text-muted-foreground">{formatAbsoluteDate(at)}</span>
    <span className="h-px flex-1 bg-border" />
  </div>
)

const isTextSegment = (segment: unknown): segment is { type: 'text'; text: string } =>
  typeof segment === 'object' && segment !== null &&
  (segment as { type?: unknown }).type === 'text' &&
  typeof (segment as { text?: unknown }).text === 'string'

const isOfferSegment = (
  segment: unknown,
): segment is { type: 'preloaded_responses'; responses: PreloadedResponse[] } =>
  typeof segment === 'object' && segment !== null &&
  (segment as { type?: unknown }).type === 'preloaded_responses' &&
  Array.isArray((segment as { responses?: unknown }).responses)

const isBreadcrumbSegment = (
  segment: unknown,
): segment is { type: 'breadcrumb'; title: string; taskCount: number; alertResolved: boolean; closedAt: number } =>
  typeof segment === 'object' && segment !== null &&
  (segment as { type?: unknown }).type === 'breadcrumb' &&
  typeof (segment as { title?: unknown }).title === 'string' &&
  typeof (segment as { taskCount?: unknown }).taskCount === 'number' &&
  typeof (segment as { alertResolved?: unknown }).alertResolved === 'boolean'

/**
 * One collapsed row standing in for all messages of a closed subject.
 *
 * The full content remains accessible through history and search; it is not
 * replayed in the main transcript so that closed subjects stop adding noise
 * to the operator's conversation view.
 */
const ClosedSubjectBreadcrumb = ({
  title,
  messageCount,
  boundary,
}: {
  title: string
  messageCount: number
  boundary?: SubjectBoundary
}) => (
  <div
    data-testid="closed-subthread-breadcrumb"
    className="rounded border border-muted px-3 py-2 font-mono text-label text-muted-foreground"
  >
    <span>{title}</span>
    <span> · {messageCount} {messageCount === 1 ? 'message' : 'messages'}</span>
    {boundary !== undefined && (
      <>
        <span> · {formatCompactCount(boundary.producedTokens)} produced</span>
        <span> · {formatCompactCount(boundary.carriedTokens)} carried</span>
      </>
    )}
  </div>
)

/** Persisted portion of Mars's one chronological conversation. */
export const ConversationTimeline = ({
  entries,
  boundaries = [],
  memoryStartsAfterSeq = 0,
  activeThreadId,
  projectId,
  onResponseComplete,
  onClientResolve,
  composerHeight = 0,
  loadError,
}: ConversationTimelineProps) => {
  const [visibleSubjectCount, setVisibleSubjectCount] = useState(INITIAL_SUBJECTS)

  // Mark all notice entries present on first render as already-revealed so
  // TypedBody does not replay the whole backlog when the timeline mounts.
  // This runs synchronously during render (before any layout effects), so
  // TypedBody's own layout effect sees the ids as revealed and skips animation.
  const initialRevealDone = useRef(false)
  if (!initialRevealDone.current) {
    initialRevealDone.current = true
    markRevealed(entries.filter((e) => e.kind === 'notice').map((e) => e.id))
  }

  const visibleEntries = entries.filter((entry) => entry.threadId !== activeThreadId)
  const boundariesBySubject = new Map(boundaries.map((boundary) => [boundary.subjectId, boundary]))

  // Group entries by subject, preserving chronological order of first appearance.
  // Closed subjects collapse to one breadcrumb row; open subjects render their
  // messages individually so streamed content stays live.
  const subjectOrder: string[] = []
  const subjectGroups = new Map<string, ChatConversationEntry[]>()
  for (const entry of visibleEntries) {
    if (!subjectGroups.has(entry.subjectId)) {
      subjectOrder.push(entry.subjectId)
      subjectGroups.set(entry.subjectId, [])
    }
    subjectGroups.get(entry.subjectId)!.push(entry)
  }

  // Day seams sit between SUBJECT GROUPS, not between entries.
  //
  // The transcript is ordered by subject, and a subject's own messages can
  // straddle midnight, so a per-entry day cursor would drop a separator
  // mid-conversation and then another one back again. The group is the unit
  // the reader actually scans, so the seam goes where a group's first message
  // lands on a different day than the previous group's last one.
  //
  // Computed here over the render order rather than tracked with a mutable
  // cursor inside the nested map, so it does not depend on the order React
  // happens to evaluate those maps in — and so it reaches the closed-subject
  // breadcrumbs, which render no entries of their own and would otherwise
  // leave a bare "22:55" with no day anywhere near it.
  const dayStartSubjectIds = new Set<string>()
  {
    let lastDay: string | null = null
    for (const subjectId of subjectOrder) {
      const group = subjectGroups.get(subjectId)!
      if (localDayKey(group[0]!.createdAt) !== lastDay) dayStartSubjectIds.add(subjectId)
      lastDay = localDayKey(group[group.length - 1]!.createdAt)
    }
  }

  // A Situation report is a snapshot of the queue at one moment, written in the
  // present tense. Four of them stacked in one transcript, each stating a
  // different set of counts as though it were true now, is four contradictions
  // and no way to tell which one still holds. Only the newest is current; the
  // rest are history and render as a one-line seam.
  const situationIds = visibleEntries.filter((e) => e.kind === 'situation').map((e) => e.id)
  const currentSituationId = situationIds.length > 0 ? situationIds[situationIds.length - 1]! : null
  const isSuperseded = (entry: ChatConversationEntry): boolean =>
    entry.kind === 'situation' && entry.id !== currentSituationId

  // Being the newest Situation does not make it true.
  //
  // The survivor sits at the bottom of the thread as Mars's current word, in
  // flat present tense — "0 queued tasks, 2 running tasks … 31 items need
  // attention" — when the app's own header said 36 and four of its five
  // numbers were days out of date. Collapsing the older ones was right; it
  // just left one stale block standing as the truth.
  //
  // A snapshot older than an hour is history, and says so above itself.
  const STALE_SITUATION_MS = 60 * 60 * 1000
  const isStaleSituation = (entry: ChatConversationEntry): boolean =>
    entry.kind === 'situation' &&
    entry.id === currentSituationId &&
    Date.now() - new Date(entry.createdAt).getTime() > STALE_SITUATION_MS

  // Paginate: show only the most recent N subjects on first paint.
  // Older subjects are hidden behind "Show N earlier" so the first paint stays
  // fast — the same pattern used by the Control Room's steward timeline.
  const totalSubjectCount = subjectOrder.length
  const hiddenSubjectCount = Math.max(0, totalSubjectCount - visibleSubjectCount)
  const visibleSubjectOrder = subjectOrder.slice(hiddenSubjectCount)

  // When the fetch failed and there is nothing to render, surface the failure
  // explicitly so the operator can distinguish "no messages yet" from "messages
  // failed to load". An empty timeline with no explanation reads as intentional
  // silence; a schema mismatch or network error requires operator action.
  if (loadError !== undefined && visibleEntries.length === 0) {
    const message = loadError instanceof Error
      ? loadError.message
      : 'Unknown error loading conversation.'
    return (
      <section aria-label="Conversation timeline" data-testid="conversation-timeline" className="space-y-4">
        <p
          role="alert"
          data-testid="conversation-load-error"
          className="text-label text-error"
        >
          {message}
        </p>
      </section>
    )
  }

  return (
    <section aria-label="Conversation timeline" data-testid="conversation-timeline" className="space-y-4">
      {hiddenSubjectCount > 0 && (
        <button
          type="button"
          onClick={() => setVisibleSubjectCount((c) => c + INITIAL_SUBJECTS)}
          data-testid="show-earlier-button"
          /* Was an all-caps underlined anchor with no chrome — the only
             control in the transcript that looked like raw HTML. It is a
             button, so it looks like one. */
          className="mx-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-label font-medium text-muted-foreground shadow-[var(--shadow-e1)] transition-colors hover:bg-background hover:text-foreground"
        >
          <ChevronUp size={12} strokeWidth={2} aria-hidden="true" />
          Show {hiddenSubjectCount} earlier
        </button>
      )}
      {visibleSubjectOrder.map((subjectId) => {
        const subjectEntries = subjectGroups.get(subjectId)!
        const isClosed = subjectEntries[0]!.subjectClosed
        const boundary = boundariesBySubject.get(subjectId)

        const daySeam = dayStartSubjectIds.has(subjectId) ? (
          <DaySeparator at={subjectEntries[0]!.createdAt} />
        ) : null

        if (isClosed) {
          // Closed subjects collapse to one breadcrumb. The memory cut may
          // fall within the subject's entries — if so, place the boundary
          // marker immediately after the breadcrumb.
          const hasMemoryCut =
            memoryStartsAfterSeq > 0 &&
            subjectEntries.some((e) => e.seq === memoryStartsAfterSeq)

          // A single-message closed subject with no active thread shows its
          // message inline below the breadcrumb. The operator has full context
          // at a glance and there is nothing meaningful to collapse. Multi-message
          // subjects, or those rendered while an active thread is open, fold
          // to a breadcrumb so noise is not replayed into the working view.
          const showInline = subjectEntries.length === 1 && activeThreadId == null
          if (showInline) {
            const entry = subjectEntries[0]!
            const segmentText = entry.segments.filter(isTextSegment).map((segment) => segment.text).join('\n')
            const body = segmentText || entry.content
            const isNotice = entry.kind === 'notice'
            return (
              <Fragment key={subjectId}>
                {daySeam}
                <ClosedSubjectBreadcrumb
                  title={entry.subjectTitle}
                  messageCount={1}
                  boundary={boundary}
                />
                <article
                  data-thread-id={entry.threadId}
                  data-message-kind={entry.kind}
                  data-testid={isNotice ? `notice-card-${entry.id}` : undefined}
                  className={isNotice ? 'mars-card rounded-md bg-card p-3' : undefined}
                >
                  <header className="mb-1.5 flex items-center gap-2 text-micro text-muted-foreground">
                    {isNotice ? (
                      <span className="shrink-0 font-medium text-foreground">Mars</span>
                    ) : (
                      <span
                        className="min-w-0 max-w-[42ch] truncate"
                        title={entry.subjectTitle || undefined}
                      >
                        {entry.subjectTitle || 'Untitled subject'}
                      </span>
                    )}
                    {!isNotice && <span className="shrink-0">closed</span>}
                    <span
                      className={
                        isNotice
                          ? 'shrink-0 rounded bg-muted-foreground/[0.08] px-1.5 py-0.5'
                          : 'shrink-0 font-medium text-foreground'
                      }
                    >
                      {entry.role} · {friendlyKind(entry.kind)}
                    </span>
                    {entry.backingEntityId && (
                      <details className="inline">
                        <summary className="cursor-pointer font-mono text-micro text-muted-foreground underline decoration-dotted">
                          details
                        </summary>
                        <span className="ml-1 select-all">{entry.backingEntityId}</span>
                      </details>
                    )}
                    {entry.resolution === 'resolved' && (
                      <span data-testid="conversation-message-resolved">Resolved</span>
                    )}
                    <MessageTime at={entry.createdAt} />
                  </header>
                  <p className="max-w-[68ch] whitespace-pre-wrap text-body leading-relaxed text-foreground">{body}</p>
                </article>
                {hasMemoryCut && <MemoryBoundaryLine />}
              </Fragment>
            )
          }

          return (
            <Fragment key={subjectId}>
              {daySeam}
              <ClosedSubjectBreadcrumb
                title={subjectEntries[0]!.subjectTitle}
                messageCount={subjectEntries.length}
                boundary={boundary}
              />
              {hasMemoryCut && <MemoryBoundaryLine />}
            </Fragment>
          )
        }

        // Open subject: render each entry with boundary seams and memory marker.
        const openEntries = subjectEntries.map((entry, index) => {
          const isFirstSubjectMessage = index === 0
          const isFinalSubjectMessage = index === subjectEntries.length - 1

          // context_line entries are folded-back Subject outcomes. Render them
          // as a compact navigable breadcrumb row so they read as a milestone
          // in the feed rather than as an ordinary message.
          if (entry.kind === 'context_line') {
            const breadcrumb = entry.segments.find(isBreadcrumbSegment)
            return (
              <Fragment key={entry.id}>
                <div
                  data-testid="context-line-breadcrumb"
                  className="rounded border border-muted px-3 py-2 font-mono text-label text-muted-foreground"
                >
                  <span>{breadcrumb?.title ?? entry.content}</span>
                  {breadcrumb !== undefined && (
                    <>
                      <span
                        className="ml-2 rounded bg-muted-foreground/[0.08] px-1.5 py-0.5"
                      >
                        {breadcrumb.alertResolved ? 'Resolved' : 'Closed'}
                      </span>
                      <span> · {breadcrumb.taskCount} {breadcrumb.taskCount === 1 ? 'task' : 'tasks'} queued</span>
                    </>
                  )}
                </div>
                {memoryStartsAfterSeq > 0 && entry.seq === memoryStartsAfterSeq && <MemoryBoundaryLine />}
              </Fragment>
            )
          }

          const segmentText = entry.segments.filter(isTextSegment).map((segment) => segment.text).join('\n')
          const body = segmentText || entry.content
          // A Notice is Mars speaking unprompted. It gets a card and a reveal;
          // the operator's own turns and ordinary replies stay plain, so the
          // difference between "I said this" and "Mars said this" is visible.
          const isNotice = entry.kind === 'notice'
          const isOperator = entry.role === 'user'

          // A superseded Situation collapses to its own seam: kept in place so
          // the history is not rewritten, but no longer asserting numbers that
          // a later report has already replaced.
          if (isSuperseded(entry)) {
            return (
              <Fragment key={entry.id}>
                <div
                  data-testid="conversation-situation-superseded"
                  className="flex items-center gap-2 px-1 py-0.5 text-micro text-muted-foreground/70"
                >
                  <span className="h-px w-4 bg-border" />
                  <span>Situation at {formatClockTime(entry.createdAt)} — superseded</span>
                </div>
                {memoryStartsAfterSeq > 0 && entry.seq === memoryStartsAfterSeq && <MemoryBoundaryLine />}
              </Fragment>
            )
          }

          return (
            <Fragment key={entry.id}>
              {boundary && isFirstSubjectMessage && <SubjectBoundaryLine boundary={boundary} position="start" />}
              <article
                data-thread-id={entry.threadId}
                data-message-kind={entry.kind}
                data-message-role={entry.role}
                data-testid={isNotice ? `notice-card-${entry.id}` : undefined}
                /* The operator's turn and Mars's turn used to be typeset
                   identically — same left edge, same ground, same size — so a
                   thread read as one undifferentiated column and the only cue
                   for who was speaking was an 11px meta line. Mars speaks on a
                   surface; the operator's turn is marked by an accent rail. */
                className={
                  isNotice
                    ? 'mars-card rounded-md bg-card p-3'
                    : isOperator
                      ? 'border-l-2 border-highlight/45 pl-3'
                      : 'rounded-md border border-border bg-card px-3 py-2.5'
                }
              >
                {/* The thread subject is NOT repeated here. Entries are already
                    grouped by subject and the group carries a SubjectBoundaryLine,
                    so printing the title on every turn restated the same string
                    three times in a row — and, unbounded in a flex row, pushed
                    the rest of the meta out to x≈1845 at 1440px wide. */}
                <header className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-muted-foreground">
                  <span className="shrink-0 font-medium text-foreground">
                    {isNotice ? 'Mars' : isOperator ? 'You' : 'Mars'}
                  </span>
                  <span className={isNotice ? 'shrink-0 rounded bg-muted-foreground/[0.08] px-1.5 py-0.5' : 'shrink-0'}>{friendlyKind(entry.kind)}</span>
                  {entry.backingEntityId && (
                    <details className="inline">
                      <summary className="cursor-pointer font-mono text-micro text-muted-foreground underline decoration-dotted">
                        details
                      </summary>
                      <span className="ml-1 select-all">{entry.backingEntityId}</span>
                    </details>
                  )}
                  {entry.resolution === 'resolved' && (
                    <span data-testid="conversation-message-resolved">Resolved</span>
                  )}
                  <MessageTime at={entry.createdAt} />
                </header>
                {isStaleSituation(entry) && (
                  <p
                    className="mb-1 text-micro text-warn"
                    data-testid="conversation-situation-stale"
                  >
                    Snapshot from {formatAbsoluteDateTime(entry.createdAt)} — the counts below
                    were true then. The sidebar has the live ones.
                  </p>
                )}
                {isNotice ? (
                  <TypedBody
                    id={entry.id}
                    text={body}
                    className="max-w-[68ch] whitespace-pre-wrap text-body leading-relaxed text-foreground"
                  />
                ) : (
                  <p
                    className={[
                      'max-w-[68ch] whitespace-pre-wrap text-body leading-relaxed',
                      isStaleSituation(entry) ? 'text-muted-foreground' : 'text-foreground',
                    ].join(' ')}
                  >
                    {body}
                  </p>
                )}
                {entry.segments.filter(isOfferSegment).map((segment) => (
                  <PreloadedResponses
                    key={`${entry.id}-preloaded-responses`}
                    messageId={entry.id}
                    responses={segment.responses}
                    resolved={entry.resolution === 'resolved'}
                    projectId={projectId}
                    onComplete={onResponseComplete}
                    onClientResolve={onClientResolve}
                  />
                ))}
              </article>
              {boundary && boundary.closedAt !== null && isFinalSubjectMessage && <SubjectBoundaryLine boundary={boundary} position="end" />}
              {memoryStartsAfterSeq > 0 && entry.seq === memoryStartsAfterSeq && <MemoryBoundaryLine />}
            </Fragment>
          )
        })

        return (
          <Fragment key={subjectId}>
            {daySeam}
            {openEntries}
          </Fragment>
        )
      })}
      {/* Spacer so the final entry is never hidden behind the composer.
          Height is measured by the parent via ResizeObserver and kept in sync
          as the composer's textarea grows with a multi-line draft. */}
      <div
        aria-hidden="true"
        data-testid="composer-scroll-spacer"
        style={{ height: composerHeight }}
      />
    </section>
  )
}
