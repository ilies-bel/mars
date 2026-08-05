import type { ReactNode } from 'react'
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

/** How many follow-up subjects the briefing names before deferring to Context. */
const NAMED_FOLLOW_UPS = 2

export const pickRandomProposal = (proposals: DraftFeature[], random = Math.random): DraftFeature | undefined => {
  if (proposals.length === 0) return undefined
  return proposals[Math.min(Math.floor(random() * proposals.length), proposals.length - 1)]
}

/** The operator-facing name of a subject, whatever kind of work backs it. */
const openWorkTitle = (item: OpenWorkItem): string =>
  item.source === 'alert' ? item.item.title : item.task.title

/**
 * Why this subject is in the operator's lap, phrased as a clause that reads
 * naturally after an em dash. Deliberately short: the opening message is a
 * sentence, not a status table.
 */
const openWorkReason = (item: OpenWorkItem): string => {
  if (item.source === 'blocked-task') return "it's blocked and can't move on its own"
  if (item.item.kind === 'stale-worktree') return 'its worktree has gone stale'
  if (item.item.kind === 'awaiting-validation') return 'it finished and is waiting on your call'
  return 'it failed and needs a decision'
}

/** Join names the way a person would: "a", "a and b", "a, b and c". */
const joinNaturally = (parts: ReactNode[]): ReactNode[] => {
  const joined: ReactNode[] = []
  parts.forEach((part, index) => {
    if (index > 0) joined.push(index === parts.length - 1 ? ' and ' : ', ')
    joined.push(part)
  })
  return joined
}

const plural = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`

const linkClass =
  'text-left text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:text-foreground'

/**
 * The main thread's opening message: a natural-language briefing that names the
 * subjects the operator has to treat, says where to start and why, and hands
 * the tail off to the Context rail. Deterministic — no provider call — so
 * returning to the main thread never costs a token.
 */
export const ChatGreeting = ({ rankedOpenWork, proposals, onOpenWork, onShowRail, onOpenProposal }: ChatGreetingProps) => {
  const drafts = proposals.filter(({ status }) => status === 'draft')
  const nextMove = rankedOpenWork[0]

  const subjectButton = (item: OpenWorkItem, testId: string): ReactNode => (
    <button
      key={item.id}
      type="button"
      className={linkClass}
      data-testid={testId}
      onClick={() => onOpenWork(item)}
    >
      {openWorkTitle(item)}
    </button>
  )

  if (!nextMove) {
    const proposal = pickRandomProposal(drafts)
    return (
      <div data-testid="chat-greeting">
        <p className="font-mono text-[14px] leading-relaxed text-foreground">
          {drafts.length === 0
            ? 'All clear — nothing needs you right now.'
            : `Nothing is failing or blocked right now. ${plural(drafts.length, 'draft')} ${
                drafts.length === 1 ? 'is' : 'are'
              } waiting to be shaped whenever you want to pick one up.`}
        </p>
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

  const followUps = rankedOpenWork.slice(1, 1 + NAMED_FOLLOW_UPS)
  const unnamedCount = rankedOpenWork.length - 1 - followUps.length

  return (
    <p className="font-mono text-[14px] leading-relaxed text-foreground" data-testid="chat-greeting">
      {rankedOpenWork.length === 1
        ? 'One subject needs you.'
        : `${plural(rankedOpenWork.length, 'subject')} need you.`}{' '}
      Start with {subjectButton(nextMove, 'chat-greeting-next-move')} — {openWorkReason(nextMove)}.
      {followUps.length > 0 && (
        <>
          {' After that, '}
          {joinNaturally(followUps.map((item) => subjectButton(item, `chat-greeting-follow-up-${item.id}`)))}
          {unnamedCount > 0 ? (
            <>
              {', plus '}
              <button type="button" className={linkClass} data-testid="chat-greeting-remaining" onClick={onShowRail}>
                {plural(unnamedCount, 'more open item')}
              </button>
              {' in Context.'}
            </>
          ) : (
            '.'
          )}
        </>
      )}
      {drafts.length > 0 && (
        <>
          {' '}
          <button type="button" className={linkClass} data-testid="chat-greeting-drafts" onClick={onShowRail}>
            {plural(drafts.length, 'draft')}
          </button>
          {drafts.length === 1 ? ' is' : ' are'} also waiting to be shaped.
        </>
      )}
    </p>
  )
}
