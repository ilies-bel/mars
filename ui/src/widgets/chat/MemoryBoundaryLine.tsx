/** Marks the earliest durable message Mars includes in its readable memory. */
export const MemoryBoundaryLine = () => (
  <div
    aria-label="Mars can read from here"
    className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground"
    data-testid="memory-boundary-line"
    role="separator"
  >
    <span className="h-px flex-1 bg-border" />
    <span>Mars can read from here</span>
    <span className="h-px flex-1 bg-border" />
  </div>
)
