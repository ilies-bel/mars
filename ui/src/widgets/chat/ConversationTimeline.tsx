import type { ChatConversationEntry } from '@/shared/schemas'

export interface ConversationTimelineProps {
  entries: ChatConversationEntry[]
  /** The active Subject is rendered by ChatConversation so streamed state has one owner. */
  activeThreadId?: string | null
}

/** Persisted portion of Mars's one chronological conversation. */
export const ConversationTimeline = ({ entries, activeThreadId }: ConversationTimelineProps) => (
  <section aria-label="Conversation timeline" data-testid="conversation-timeline" className="space-y-4">
    {entries
      .filter((entry) => entry.threadId !== activeThreadId)
      .map((entry) => {
        const segmentText = entry.segments
          .filter((segment): segment is { type: 'text'; text: string } =>
            typeof segment === 'object' && segment !== null &&
            (segment as { type?: unknown }).type === 'text' &&
            typeof (segment as { text?: unknown }).text === 'string',
          )
          .map((segment) => segment.text)
          .join('\n')
        return (
          <article key={entry.id} data-thread-id={entry.threadId} data-message-kind={entry.kind}>
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
          </article>
        )
      })}
  </section>
)
