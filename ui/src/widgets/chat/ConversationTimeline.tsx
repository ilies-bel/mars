import { Fragment, useRef } from 'react'
import type { ChatConversationEntry, PreloadedResponse, SubthreadBoundary } from '@/shared/schemas'
import { MemoryBoundaryLine } from './MemoryBoundaryLine'
import { PreloadedResponses } from './PreloadedResponses'
import { SubthreadBoundaryLine } from './SubthreadBoundaryLine'
import { TypedBody, markRevealed } from './TypedBody'

export interface ConversationTimelineProps {
  entries: ChatConversationEntry[]
  /** Subthread seams and final aggregate token weight from the conversation API. */
  boundaries?: SubthreadBoundary[]
  /** The last durable message outside Mars's current readable memory. */
  memoryStartsAfterSeq?: number
  /** The active Subthread is rendered by ChatConversation so streamed state has one owner. */
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
}

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

/**
 * One collapsed row standing in for all messages of a closed subthread.
 *
 * The full content remains accessible through history and search; it is not
 * replayed in the main transcript so that closed subthreads stop adding noise
 * to the operator's conversation view.
 */
const ClosedSubthreadBreadcrumb = ({
  title,
  messageCount,
  boundary,
}: {
  title: string
  messageCount: number
  boundary?: SubthreadBoundary
}) => (
  <div
    data-testid="closed-subthread-breadcrumb"
    className="rounded border border-muted px-3 py-2 font-mono text-[11px] text-muted-foreground"
  >
    <span>{title}</span>
    <span> · {messageCount} {messageCount === 1 ? 'message' : 'messages'}</span>
    {boundary !== undefined && (
      <>
        <span> · {boundary.producedTokens} produced</span>
        <span> · {boundary.carriedTokens} carried</span>
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
}: ConversationTimelineProps) => {
  const visibleEntries = entries.filter((entry) => entry.threadId !== activeThreadId)
  const boundariesBySubthread = new Map(boundaries.map((boundary) => [boundary.subthreadId, boundary]))

  // Everything present on the first render is backlog, not arrival. Marking it
  // during render (before any child effect runs) is what stops a page load
  // from replaying the whole conversation as if Mars were typing it now.
  const primed = useRef(false)
  if (!primed.current) {
    primed.current = true
    markRevealed(visibleEntries.map((entry) => entry.id))
  }

  // Group entries by subthread, preserving chronological order of first appearance.
  // Closed subthreads collapse to one breadcrumb row; open subthreads render their
  // messages individually so streamed content stays live.
  const subthreadOrder: string[] = []
  const subthreadGroups = new Map<string, ChatConversationEntry[]>()
  for (const entry of visibleEntries) {
    if (!subthreadGroups.has(entry.subthreadId)) {
      subthreadOrder.push(entry.subthreadId)
      subthreadGroups.set(entry.subthreadId, [])
    }
    subthreadGroups.get(entry.subthreadId)!.push(entry)
  }

  return (
    <section aria-label="Conversation timeline" data-testid="conversation-timeline" className="space-y-4">
      {subthreadOrder.map((subthreadId) => {
        const subthreadEntries = subthreadGroups.get(subthreadId)!
        const isClosed = subthreadEntries[0]!.subthreadClosed
        const boundary = boundariesBySubthread.get(subthreadId)

        if (isClosed) {
          // Closed subthreads collapse to one breadcrumb. The memory cut may
          // fall within the subthread's entries — if so, place the boundary
          // marker immediately after the breadcrumb.
          const hasMemoryCut =
            memoryStartsAfterSeq > 0 &&
            subthreadEntries.some((e) => e.seq === memoryStartsAfterSeq)
          return (
            <Fragment key={subthreadId}>
              <ClosedSubthreadBreadcrumb
                title={subthreadEntries[0]!.subthreadTitle}
                messageCount={subthreadEntries.length}
                boundary={boundary}
              />
              {hasMemoryCut && <MemoryBoundaryLine />}
            </Fragment>
          )
        }

        // Open subthread: render each entry with boundary seams and memory marker.
        return subthreadEntries.map((entry, index) => {
          const isFirstSubthreadMessage = index === 0
          const isFinalSubthreadMessage = index === subthreadEntries.length - 1
          const segmentText = entry.segments.filter(isTextSegment).map((segment) => segment.text).join('\n')
          const body = segmentText || entry.content
          // A Notice is Mars speaking unprompted. It gets a card and a reveal;
          // the operator's own turns and ordinary replies stay plain, so the
          // difference between "I said this" and "Mars said this" is visible.
          const isNotice = entry.kind === 'notice'

          return (
            <Fragment key={entry.id}>
              {boundary && isFirstSubthreadMessage && <SubthreadBoundaryLine boundary={boundary} position="start" />}
              <article
                data-thread-id={entry.threadId}
                data-message-kind={entry.kind}
                data-testid={isNotice ? `notice-card-${entry.id}` : undefined}
                className={isNotice ? 'rounded-md border border-primary/20 bg-primary/5 p-3' : undefined}
              >
                <header className="mb-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                  {isNotice ? (
                    <span className="text-primary">Mars</span>
                  ) : (
                    <span>{entry.subthreadTitle || 'Untitled subthread'}</span>
                  )}
                  {!isNotice && <span>{entry.subthreadClosed ? 'closed' : 'open'}</span>}
                  <span>{entry.role} · {entry.kind}</span>
                  {entry.backingEntityId && <span>{entry.backingEntityId}</span>}
                  {entry.resolution === 'resolved' && (
                    <span data-testid="conversation-message-resolved">Resolved</span>
                  )}
                </header>
                {isNotice ? (
                  <TypedBody
                    id={entry.id}
                    text={body}
                    className="whitespace-pre-wrap font-mono text-[13px] text-foreground"
                  />
                ) : (
                  <p className="whitespace-pre-wrap font-mono text-[13px] text-foreground">{body}</p>
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
              {boundary && boundary.closedAt !== null && isFinalSubthreadMessage && <SubthreadBoundaryLine boundary={boundary} position="end" />}
              {memoryStartsAfterSeq > 0 && entry.seq === memoryStartsAfterSeq && <MemoryBoundaryLine />}
            </Fragment>
          )
        })
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
