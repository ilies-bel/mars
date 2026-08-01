import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchChatThread } from '@/shared/api'
import type { ChatThread } from '@/shared/schemas'

export type ThreadSummary = Pick<ChatThread, 'id' | 'title' | 'createdAt'>

interface PastSubthreadsColumnProps {
  pastThreads: ThreadSummary[]
  projectId?: string
}

const PastSubthreadMessages = ({ threadId, projectId }: { threadId: string; projectId?: string }) => {
  const { data: detail, isLoading } = useQuery({
    queryKey: ['chat-thread', threadId, projectId],
    queryFn: () => fetchChatThread(threadId, projectId),
  })

  if (isLoading) {
    return <p className="px-3 pb-3 font-mono text-[11px] text-muted-foreground">Loading messages…</p>
  }

  return (
    <div className="space-y-2 px-3 pb-3" aria-label="Past Subthread messages">
      {(detail?.messages ?? []).map((message) => (
        <p
          key={message.id}
          className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground"
        >
          {message.segments
            .filter((segment) => segment.type === 'text')
            .map((segment) => segment.text)
            .join('\n')}
        </p>
      ))}
    </div>
  )
}

const PastSubthreadBlock = ({ thread, projectId }: { thread: ThreadSummary; projectId?: string }) => {
  const [expanded, setExpanded] = useState(false)
  const panelId = `past-subthread-${thread.id}`

  return (
    <article data-testid="past-subthread" className="border-b border-primary/15">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-primary/5"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden="true" className="font-mono text-[10px] text-muted-foreground">
          {expanded ? '−' : '+'}
        </span>
        <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">
          {thread.title || 'Untitled Subthread'}
        </span>
      </button>
      {expanded && (
        <div id={panelId}>
          <PastSubthreadMessages threadId={thread.id} projectId={projectId} />
        </div>
      )}
    </article>
  )
}

export const PastSubthreadsColumn = ({ pastThreads, projectId }: PastSubthreadsColumnProps) => {
  if (pastThreads.length === 0) return null

  return (
    <section data-testid="past-subthreads-column" aria-label="Past Subthreads" className="mb-4 border-y border-primary/15">
      {pastThreads
        .slice()
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map((thread) => <PastSubthreadBlock key={thread.id} thread={thread} projectId={projectId} />)}
    </section>
  )
}
