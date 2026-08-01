import type { SubthreadBoundary } from '@/shared/schemas'

export const SubthreadBoundaryLine = ({
  boundary,
  position,
}: {
  boundary: SubthreadBoundary
  position: 'start' | 'end'
}) => (
  <div
    aria-label={position === 'start' ? 'Subthread started' : 'Subthread complete'}
    className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground"
    data-testid={`subthread-boundary-${position}`}
    data-subthread-id={boundary.subthreadId}
    role="separator"
  >
    <span className="h-px flex-1 bg-primary/15" />
    {position === 'start' ? (
      <span>Subthread started</span>
    ) : (
      <span>Subthread complete · {boundary.producedTokens.toLocaleString()} produced · {boundary.carriedTokens.toLocaleString()} carried</span>
    )}
    <span className="h-px flex-1 bg-primary/15" />
  </div>
)
