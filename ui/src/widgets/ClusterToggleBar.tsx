/**
 * ClusterToggleBar – four toggle chips that control which clusters are visible
 * on the Progress tab (both the DAG topology view and the board column view).
 *
 * The 'Arc' chip controls visibility of arc combos (proposal-backed arcs,
 * origin arcs, and solo tasks). The other three chips control task clusters.
 *
 * The component is controlled: the parent owns `active` (the set of currently-on
 * clusters) and handles state updates via `onToggle`.
 */

export type ClusterToggle = 'Arc' | 'In progress' | 'Blocked' | 'Failed'

export const ALL_CLUSTER_TOGGLES: readonly ClusterToggle[] = [
  'Arc',
  'In progress',
  'Blocked',
  'Failed',
]

interface ClusterToggleBarProps {
  /** Set of clusters currently toggled ON. */
  active: Set<ClusterToggle>
  /** Called when the user clicks a toggle chip. */
  onToggle: (cluster: ClusterToggle) => void
}

const chipClass = (on: boolean): string =>
  [
    'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors cursor-pointer select-none',
    on
      ? 'border-iron/60 bg-iron/30 text-fg'
      : 'border-iron/30 bg-transparent text-iron hover:border-iron/50 hover:text-fg',
  ].join(' ')

export const ClusterToggleBar = ({ active, onToggle }: ClusterToggleBarProps) => (
  <div
    role="toolbar"
    aria-label="Cluster visibility toggles"
    className="flex items-center gap-2 border-b border-iron/20 bg-bg px-4 py-1.5"
  >
    {ALL_CLUSTER_TOGGLES.map((cluster) => {
      const on = active.has(cluster)
      return (
        <button
          key={cluster}
          type="button"
          role="switch"
          aria-checked={on}
          data-testid={`toggle-${cluster.replace(/ /g, '-').toLowerCase()}`}
          className={chipClass(on)}
          onClick={() => onToggle(cluster)}
        >
          {cluster}
        </button>
      )
    })}
  </div>
)
