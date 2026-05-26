/**
 * Empty state shown in the Graph view when no task data has been loaded.
 * Points the operator at the CLI command to add their first task.
 */
export const EmptyState = () => (
  <div
    data-testid="graph-empty-state"
    className="flex h-full w-full flex-col items-center justify-center gap-2"
  >
    <span className="font-mono text-[13px] text-muted">
      No tasks yet — run{' '}
      <code className="rounded bg-panel px-1.5 py-0.5 text-fg">
        mars task add
      </code>{' '}
      to get started
    </span>
  </div>
)
