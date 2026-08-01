import type { SubjectBoundary } from '@/shared/schemas'

export const SubjectBoundaryLine = ({
  boundary,
  position,
}: {
  boundary: SubjectBoundary
  position: 'start' | 'end'
}) => (
  <div
    aria-label={position === 'start' ? 'Subject started' : 'Subject complete'}
    className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground"
    data-testid={`subject-boundary-${position}`}
    data-subject-id={boundary.subjectId}
    role="separator"
  >
    <span className="h-px flex-1 bg-primary/15" />
    {position === 'start' ? (
      <span>Subject started</span>
    ) : (
      <span>Subject complete · {boundary.producedTokens.toLocaleString()} produced · {boundary.carriedTokens.toLocaleString()} carried</span>
    )}
    <span className="h-px flex-1 bg-primary/15" />
  </div>
)
