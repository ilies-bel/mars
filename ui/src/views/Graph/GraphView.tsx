import { EmptyState } from './EmptyState'

/**
 * Graph view — renders the task dependency DAG.
 *
 * This is the shell: routing is wired and the empty state is shown.
 * Data fetching and DAG rendering will be added in subsequent slices.
 */
export const GraphView = () => (
  <div className="flex min-h-0 flex-1 overflow-hidden bg-bg">
    <EmptyState />
  </div>
)
