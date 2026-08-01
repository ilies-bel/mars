import { Fragment } from 'react'
import type { ChatConversationEntry, SubthreadBoundary } from '@/shared/schemas'
import { MemoryBoundaryLine } from './MemoryBoundaryLine'
import { PreloadedResponses } from './PreloadedResponses'
import { SubthreadBoundaryLine } from './SubthreadBoundaryLine'

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
}

/** Persisted portion of Mars's one chronological conversation. */
export const ConversationTimeline = ({
  entries,
  boundaries = [],
  memoryStartsAfterSeq = 0,
  activeThreadId,
  projectId,
  onResponseComplete,
}: ConversationTimelineProps) => {
  const visibleEntries = entries.filter((entry) => entry.threadId !== activeThreadId)
  const boundariesBySubthread = new Map(boundaries.map((boundary) => [boundary.subthreadId, boundary]))

  return (
    <section aria-label="Conversation timeline" data-testid="conversation-timeline" className="space-y-4">
      {visibleEntries.map((entry, index) => {
        const boundary = boundariesBySubthread.get(entry.subthreadId)
        const isFirstSubthreadMessage = !visibleEntries.slice(0, index).some((earlier) => earlier.subthreadId === entry.subthreadId)
        const isFinalSubthreadMessage = !visibleEntries.slice(index + 1).some((later) => later.subthreadId === entry.subthreadId)
        const segmentText = entry.segments
          .filter((segment): segment is { type: 'text'; text: string } =>
            typeof segment === 'object' && segment !== null &&
            (segment as { type?: unknown }).type === 'text' &&
            typeof (segment as { text?: unknown }).text === 'string',
          )
          .map((segment) => segment.text)
          .join('\n')
        return (
          <Fragment key={entry.id}>
            {boundary && isFirstSubthreadMessage && <SubthreadBoundaryLine boundary={boundary} position="start" />}
            <article data-thread-id={entry.threadId} data-message-kind={entry.kind}>
              <header className="mb-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                <span>{entry.subthreadTitle || 'Untitled subthread'}</span>
                <span>{entry.subthreadClosed ? 'closed' : 'open'}</span>
                <span>{entry.role} · {entry.kind}</span>
                {entry.backingEntityId && <span>{entry.backingEntityId}</span>}
                {entry.resolution === 'resolved' && (
                  <span data-testid="conversation-message-resolved">Resolved</span>
                )}
              </header>
              <p className="whitespace-pre-wrap font-mono text-[13px] text-foreground">
                {segmentText || entry.content}
              </p>
              {entry.segments
                .filter((segment): segment is { type: 'preloaded_responses'; responses: import('@/shared/schemas').PreloadedResponse[] } =>
                  typeof segment === 'object' && segment !== null &&
                  (segment as { type?: unknown }).type === 'preloaded_responses' &&
                  Array.isArray((segment as { responses?: unknown }).responses),
                )
                .map((segment) => (
                  <PreloadedResponses
                    key={`${entry.id}-preloaded-responses`}
                    messageId={entry.id}
                    responses={segment.responses}
                    resolved={entry.resolution === 'resolved'}
                    projectId={projectId}
                    onComplete={onResponseComplete}
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
