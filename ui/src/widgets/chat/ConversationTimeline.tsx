import { Fragment } from 'react'
import type { ChatConversationEntry, SubjectBoundary } from '@/shared/schemas'
import { MemoryBoundaryLine } from './MemoryBoundaryLine'
import { PreloadedResponses } from './PreloadedResponses'
import { SubjectBoundaryLine } from './SubjectBoundaryLine'

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
  const boundariesBySubject = new Map(boundaries.map((boundary) => [boundary.subjectId, boundary]))

  return (
    <section aria-label="Conversation timeline" data-testid="conversation-timeline" className="space-y-4">
      {visibleEntries.map((entry, index) => {
        const boundary = boundariesBySubject.get(entry.subjectId)
        const isFirstSubjectMessage = !visibleEntries.slice(0, index).some((earlier) => earlier.subjectId === entry.subjectId)
        const isFinalSubjectMessage = !visibleEntries.slice(index + 1).some((later) => later.subjectId === entry.subjectId)
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
            {boundary && isFirstSubjectMessage && <SubjectBoundaryLine boundary={boundary} position="start" />}
            <article data-thread-id={entry.threadId} data-message-kind={entry.kind}>
              <header className="mb-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                <span>{entry.subjectTitle || 'Untitled subject'}</span>
                <span>{entry.subjectClosed ? 'closed' : 'open'}</span>
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
            {boundary && boundary.closedAt !== null && isFinalSubjectMessage && <SubjectBoundaryLine boundary={boundary} position="end" />}
            {memoryStartsAfterSeq > 0 && entry.seq === memoryStartsAfterSeq && <MemoryBoundaryLine />}
          </Fragment>
        )
      })}
    </section>
  )
}
