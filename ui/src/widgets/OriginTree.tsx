import { useQuery } from '@tanstack/react-query'
import { fetchOrigins } from '@/shared/api'
import { originKindLabel } from '@/shared/actionQueueDetail'
import { useFocusedProjectId } from '@/shared/useFocusedProject'
import { FallbackSurface } from '@/components/FallbackSurface'
import { SkeletonList } from '@/components/Skeleton'
import type { OriginNode } from '@/shared/schemas'

interface OriginTreeProps {
  taskId: string
  /** When provided, each node row becomes a button that calls this with the node id.
   *  When omitted, rows render exactly as today (non-interactive). */
  onNavigate?: (id: string) => void
  /** The id to highlight as "current" (bold). Defaults to taskId. */
  currentId?: string
}

// The inner content of a single origin row — shared between the plain `<li>`
// render and the `onNavigate` button render so the two stay in lockstep.
const OriginNodeContent = ({ node }: { node: OriginNode }) => (
  <>
    <span className="font-mono text-[9px] uppercase text-primary">
      {originKindLabel(node.kind)}
    </span>
    <span className="break-all font-mono text-[10px] text-muted-foreground">
      {node.id}
    </span>
    <span className="break-words">
      {node.title.length > 70 ? `${node.title.slice(0, 69)}…` : node.title}
    </span>
    <span className="ml-auto font-mono text-[10px] uppercase text-muted-foreground">
      {node.status}
    </span>
  </>
)

const OriginNodeRow = ({
  node,
  depth,
  currentId,
  onNavigate,
}: {
  node: OriginNode
  depth: number
  currentId: string
  onNavigate?: (id: string) => void
}) => {
  const isCurrent = node.id === currentId
  return (
    <>
      <li
        data-origin-node-id={node.id}
        className={[
          'flex items-baseline gap-2 text-foreground',
          isCurrent ? 'font-bold pl-2' : '',
        ].join(' ')}
        style={{ marginLeft: `${depth * 12}px` }}
      >
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate(node.id)}
            className="flex w-full items-baseline gap-2 rounded text-left hover:bg-primary/10"
          >
            <OriginNodeContent node={node} />
          </button>
        ) : (
          <OriginNodeContent node={node} />
        )}
      </li>
      {node.children.map((c) => (
        <OriginNodeRow
          key={c.id}
          node={c}
          depth={depth + 1}
          currentId={currentId}
          onNavigate={onNavigate}
        />
      ))}
    </>
  )
}

/**
 * Renders the origin tree (proposal → sibling tasks → recovery `fix` tasks,
 * nested) for a task. Display-only by default; pass `onNavigate` to make each
 * node row a focusable button that reports its id on click.
 */
export const OriginTree = ({ taskId, onNavigate, currentId }: OriginTreeProps) => {
  const projectId = useFocusedProjectId()
  const query = useQuery({
    queryKey: ['origins', projectId, taskId],
    queryFn: () => fetchOrigins(taskId, projectId ?? undefined),
    // An empty taskId would produce `GET /api/origins/?project=…`, which the UI
    // server rejects with 400 (taskId is required). Never fire the request for
    // an id we know is empty — a malformed/non-task-keyed action-queue row can
    // surface here with `entityId: ''`.
    enabled: projectId !== null && taskId !== '',
  })

  if (query.isPending) {
    return (
      <div>
        <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
          Origins
        </dt>
        <dd>
          <SkeletonList rows={3} rowClassName="h-6 w-full mb-1" label="Loading origins" />
        </dd>
      </div>
    )
  }
  if (query.isError || !query.data) {
    return (
      <div>
        <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
          Origins
        </dt>
        <FallbackSurface error={query.error} of="origin tasks" variant="inline" />
      </div>
    )
  }

  const root = query.data.node
  // Single-node tree, no real ancestry — collapse to the empty-state line.
  if (root.children.length === 0 && root.id === taskId) {
    return (
      <div>
        <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
          Origins
        </dt>
        <dd className="text-muted-foreground">No origin recorded for this task.</dd>
      </div>
    )
  }

  return (
    <div>
      <dt className="mb-2 border-b border-primary/20 pb-1 text-[10px] uppercase tracking-wider text-primary">
        Origins
      </dt>
      <dd data-testid="origin-tree">
        <ul className="flex flex-col gap-1">
          <OriginNodeRow
            node={root}
            depth={0}
            currentId={currentId ?? taskId}
            onNavigate={onNavigate}
          />
        </ul>
      </dd>
    </div>
  )
}
