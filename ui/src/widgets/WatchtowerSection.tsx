const PANELS = ['Score trends', 'Promotion ledger', 'Loop ledger'] as const

const WatchtowerPanel = ({ title }: { title: string }) => (
  <div className="flex flex-col gap-2 rounded border border-border p-4">
    <h4 className="font-mono text-[11px] uppercase tracking-wide text-iron">{title}</h4>
    <p className="text-iron text-xs">No data yet</p>
  </div>
)

export const WatchtowerSection = () => (
  <div className="flex flex-col gap-3">
    <h3 className="font-mono text-[11px] uppercase tracking-wide text-iron">Watchtower</h3>
    <div className="flex flex-col gap-3">
      {PANELS.map((title) => (
        <WatchtowerPanel key={title} title={title} />
      ))}
    </div>
  </div>
)
