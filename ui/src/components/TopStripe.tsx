interface Props {
  inProgress: number
  todo: number
  done: number
  connected: boolean
}

export const TopStripe = ({ inProgress, todo, done, connected }: Props) => (
  <header className="flex h-12 items-center justify-between border-b border-border bg-bg px-6">
    <h1 className="text-[14px] font-semibold text-fg">Tasks</h1>
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2.5 font-mono text-[12px] tracking-wide">
        <span className="font-bold text-flame">{inProgress} IN PROGRESS</span>
        <span className="text-muted">·</span>
        <span className="font-semibold text-muted">{todo} TODO</span>
        <span className="text-muted">·</span>
        <span className="font-semibold text-muted">{done} DONE</span>
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
