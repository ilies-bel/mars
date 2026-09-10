import type { SubjectBoundary } from '@/shared/schemas'
import { formatCompactCount } from '@/shared/displayStrings'

export const SubjectBoundaryLine = ({
  boundary,
  position,
}: {
  boundary: SubjectBoundary
  position: 'start' | 'end'
}) => (
  <div
    aria-label={position === 'start' ? 'Subject started' : 'Subject complete'}
    className="flex items-center gap-0 font-mono text-micro text-muted-foreground"
    data-testid={`subthread-boundary-${position}`}
    data-subject-id={boundary.subjectId}
    role="separator"
  >
    <span className="h-px flex-1 bg-border" />
    {position === 'start' ? (
      <span className="bg-background px-3">Subject started</span>
    ) : (
      <span className="bg-background px-3">Subject complete · {formatCompactCount(boundary.producedTokens)} produced · {formatCompactCount(boundary.carriedTokens)} carried</span>
    )}
    <span className="h-px flex-1 bg-border" />
  </div>
)
