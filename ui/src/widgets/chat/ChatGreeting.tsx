import type { DraftFeature } from '@/shared/schemas'
import type { OpenWorkItem } from './openWork'

interface ChatGreetingProps {
  rankedOpenWork: OpenWorkItem[]
  proposals: DraftFeature[]
  onOpenWork: (item: OpenWorkItem) => void
  onShowRail: () => void
}

export const ChatGreeting = ({ rankedOpenWork, proposals, onOpenWork, onShowRail }: ChatGreetingProps) => {
  const nextMove = rankedOpenWork[0]
  if (!nextMove) return null

  const nextMoveTitle = nextMove.source === 'alert' ? nextMove.item.title : nextMove.task.title
  const remainingCount = rankedOpenWork.length - 1 + proposals.length

  return (
    <p className="font-mono text-[14px] leading-relaxed text-foreground" data-testid="chat-greeting">
      Start with{' '}
      <button
        type="button"
        className="text-left text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:text-foreground"
        data-testid="chat-greeting-next-move"
        onClick={() => onOpenWork(nextMove)}
      >
        {nextMoveTitle}
      </button>
      .
      {remainingCount > 0 && (
        <>
          {' '}
          <button
            type="button"
            className="text-left text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:text-foreground"
            data-testid="chat-greeting-remaining"
            onClick={onShowRail}
          >
            {remainingCount} more open {remainingCount === 1 ? 'item' : 'items'}
          </button>{' '}
          are waiting in Context.
        </>
      )}
    </p>
  )
}
