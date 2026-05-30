import { useQuery } from '@tanstack/react-query'
import { fetchOrigins } from '@/shared/api'
import { originKindLabel } from '@/shared/actionQueueDetail'
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
    <span className="font-mono text-[9px] uppercase text-iron">
      {originKindLabel(node.kind)}
    </span>
    <span className="break-all font-mono text-[10px] text-iron/80">
      {node.id}
    </span>
    <span className="break-words">
      {node.title.length > 70 ? `${node.title.slice(0, 69)}…` : node.title}
    </span>
    <span className="ml-auto font-mono text-[10px] uppercase text-iron/60">
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
          'flex items-baseline gap-2 text-fg',
          isCurrent ? 'font-bold pl-2' : '',
        ].join(' ')}
        style={{ marginLeft: `${depth * 12}px` }}
      >
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate(node.id)}
            className="flex w-full items-baseline gap-2 rounded text-left hover:bg-iron/10"
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
  const query = useQuery({
    queryKey: ['origins', taskId],
    queryFn: () => fetchOrigins(taskId),
  })

  if (query.isPending) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Origins
        </dt>
        <dd className="text-iron/60">Loading…</dd>
      </div>
    )
  }
  if (query.isError || !query.data) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Origins
        </dt>
        <dd className="text-error">
          Failed to load origins
          {query.error ? `: ${(query.error as Error).message}` : ''}
        </dd>
      </div>
    )
  }

  const root = query.data.node
  // Single-node tree, no real ancestry — collapse to the empty-state line.
  if (root.children.length === 0 && root.id === taskId) {
    return (
      <div>
        <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
          Origins
        </dt>
        <dd className="text-iron/60">No origin recorded for this task.</dd>
      </div>
    )
  }

  return (
    <div>
      <dt className="mb-1 text-[10px] uppercase tracking-wider text-iron">
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
