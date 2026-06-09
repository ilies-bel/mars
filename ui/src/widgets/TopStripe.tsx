import { releaseNotesHash } from '@/shared/routing'

interface Props {
  inProgress: number
  failed: number
  done: number
  connected: boolean
}

export const TopStripe = ({ inProgress, failed, done, connected }: Props) => (
  <header className="flex h-12 items-center justify-between border-b border-border bg-bg px-6">
    <div className="flex items-center gap-3">
      <h1 className="text-[14px] font-semibold text-fg">Tasks</h1>
      <button
        type="button"
        onClick={() => {
          window.location.hash = releaseNotesHash()
        }}
        className="rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10"
      >
        Release Notes
      </button>
    </div>
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2.5 font-mono text-[12px] tracking-wide">
        <span className="font-bold text-flame">{inProgress} IN PROGRESS</span>
        <span className="text-muted">·</span>
        <span className="font-semibold text-muted">{done} DONE</span>
        <span className="text-muted">·</span>
        <span className="font-semibold text-muted">{failed} FAILED</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`h-2 w-2 rounded-full bg-flame ${connected ? 'animate-mars-pulse' : 'opacity-30'}`}
        />
        <span className="font-mono text-[12px] font-medium text-fg">
          {connected ? 'live' : 'offline'}
        </span>
      </div>
    </div>
  </header>
)
