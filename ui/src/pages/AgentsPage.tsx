interface TopBarProps {
  title: string
  count?: number
  hint: string
}

const TopBar = ({ title, count, hint }: TopBarProps) => (
  <header className="flex items-center gap-3 px-6 pt-6">
    <h1 className="font-mono text-sm uppercase tracking-wide text-fg">
      {title}
    </h1>
    <span
      className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase text-iron"
      aria-label="count"
    >
      {count ?? '—'}
    </span>
    <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-iron">
      {hint}
    </span>
  </header>
)

export const AgentsPage = () => (
  <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
    <TopBar
      title="Agents"
      hint="system prompt · tools · recent runs"
    />
    <div className="flex min-h-0 flex-1 gap-4 px-6 pt-3 pb-6">
      <aside
        className="w-[340px] shrink-0 rounded-lg border border-border"
        aria-label="Agents master list"
      />
      <section
        className="min-w-0 flex-1 rounded-lg border border-border"
        aria-label="Agent detail"
      />
    </div>
  </div>
)
