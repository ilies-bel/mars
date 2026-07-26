import { releaseNotesHash } from '@/shared/routing'

interface Props {
  inProgress: number
  failed: number
  /** Tasks completed in the last 24 hours (rolling window). */
  doneToday: number
  connected: boolean
}

export const TopStripe = ({ inProgress, failed, doneToday, connected }: Props) => (
  <header className="flex h-12 items-center justify-between border-b border-border bg-background px-6">
    <div className="flex items-center gap-3">
      <h1 className="text-[14px] font-semibold text-foreground">Tasks</h1>
      <button
        type="button"
        onClick={() => {
          window.location.hash = releaseNotesHash()
        }}
        className="rounded border border-primary/40 px-2 py-0.5 font-mono text-xs text-primary hover:bg-primary/10"
      >
        Release Notes
      </button>
    </div>
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-3 font-mono tracking-wide">
        <div data-testid="stat-in-progress" className="flex items-center gap-1">
          <span className="tabular-nums text-[14px] font-bold text-status-running">{inProgress}</span>
          <span className="text-[10px] text-muted-foreground">IN PROGRESS</span>
        </div>
        <span className="text-muted-foreground">·</span>
        <button
          type="button"
          data-testid="stat-done"
          title="Tasks completed in the last 24 hours — click to view release notes"
          onClick={() => {
            window.location.hash = releaseNotesHash()
          }}
          className="flex cursor-pointer items-center gap-1 hover:opacity-80"
        >
          <span className="tabular-nums text-[14px] font-bold text-success">{doneToday}</span>
          <span className="text-[10px] text-muted-foreground">DONE TODAY</span>
        </button>
        <span className="text-muted-foreground">·</span>
        <div data-testid="stat-failed" className="flex items-center gap-1">
          <span className="tabular-nums text-[14px] font-bold text-error">{failed}</span>
          <span className="text-[10px] text-muted-foreground">FAILED</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`h-2 w-2 rounded-full bg-success ${connected ? 'animate-mars-pulse' : 'opacity-30'}`}
        />
        <span className="font-mono text-[12px] text-muted-foreground">
          {connected ? 'live' : 'offline'}
        </span>
      </div>
    </div>
  </header>
)
