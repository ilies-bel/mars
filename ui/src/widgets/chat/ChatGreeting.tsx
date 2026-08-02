import type { DraftFeature } from '@/shared/schemas'
import type { OpenWorkItem } from './openWork'
import { PreloadedResponses } from './PreloadedResponses'

interface ChatGreetingProps {
  rankedOpenWork: OpenWorkItem[]
  proposals: DraftFeature[]
  onOpenWork: (item: OpenWorkItem) => void
  onShowRail: () => void
  onOpenProposal?: (proposal: DraftFeature) => void
}

export const pickRandomProposal = (proposals: DraftFeature[], random = Math.random): DraftFeature | undefined => {
  if (proposals.length === 0) return undefined
  return proposals[Math.min(Math.floor(random() * proposals.length), proposals.length - 1)]
}

export const ChatGreeting = ({ rankedOpenWork, proposals, onOpenWork, onShowRail, onOpenProposal }: ChatGreetingProps) => {
  const nextMove = rankedOpenWork[0]
  if (!nextMove) {
    const proposal = pickRandomProposal(proposals.filter(({ status }) => status === 'draft'))
    return (
      <div data-testid="chat-greeting">
        <p className="font-mono text-[14px] leading-relaxed text-foreground">All clear.</p>
        {proposal && (
          <PreloadedResponses
            resolved={false}
            responses={[{
              id: `grill-${proposal.id}`,
              label: `Grill: ${proposal.title}`,
              target: { type: 'client', op: 'open-proposal-subject', entityId: proposal.id },
            }]}
            onClientResolve={(response) => {
              const target = response.target
              if (target.type !== 'client') return
              const currentProposal = proposals.find(({ id }) => id === target.entityId)
              if (currentProposal) onOpenProposal?.(currentProposal)
            }}
          />
        )}
      </div>
    )
  }

  const nextMoveTitle = nextMove.source === 'alert' ? nextMove.item.title : nextMove.task.title
  const remainingCount = rankedOpenWork.length - 1 + proposals.filter((proposal) => proposal.status === 'draft').length

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
