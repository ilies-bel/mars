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

/** Persisted portion of Mars's one chronological conversation. */
export const ConversationTimeline = ({
  entries,
  boundaries = [],
  memoryStartsAfterSeq = 0,
  activeThreadId,
  projectId,
  onResponseComplete,
  onClientResolve,
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

  return (
    <section aria-label="Conversation timeline" data-testid="conversation-timeline" className="space-y-4">
      {visibleEntries.map((entry, index) => {
        const boundary = boundariesBySubthread.get(entry.subthreadId)
        const isFirstSubthreadMessage = !visibleEntries.slice(0, index).some((earlier) => earlier.subthreadId === entry.subthreadId)
        const isFinalSubthreadMessage = !visibleEntries.slice(index + 1).some((later) => later.subthreadId === entry.subthreadId)
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
      })}
    </section>
  )
}
