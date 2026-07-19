import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { WatchtowerTrendChart } from './WatchtowerTrendChart'

// ---------------------------------------------------------------------------
// Score trends subsection
// ---------------------------------------------------------------------------

const ScoreTrends = () => {
  const { data: workflows, isLoading } = useScorerWorkflows()

  if (isLoading) return null

  if (!workflows || workflows.length === 0) {
    return <p className="text-iron text-xs">No scores yet</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {workflows.map((kind) => (
        <WatchtowerTrendChart key={kind} workflow={kind} window={20} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Generic placeholder panel (Promotion ledger, Loop ledger)
// ---------------------------------------------------------------------------

const PlaceholderPanel = ({ title }: { title: string }) => (
  <div className="flex flex-col gap-2 rounded border border-border p-4">
    <h4 className="font-mono text-[11px] uppercase tracking-wide text-iron">{title}</h4>
    <p className="text-iron text-xs">No data yet</p>
  </div>
)

// ---------------------------------------------------------------------------
// WatchtowerSection
// ---------------------------------------------------------------------------

export const WatchtowerSection = () => (
  <div className="flex flex-col gap-3">
    <h3 className="font-mono text-[11px] uppercase tracking-wide text-iron">Watchtower</h3>
    <div className="flex flex-col gap-3">
      {/* Score trends — live data via useScorerWorkflows + WatchtowerTrendChart */}
      <div className="flex flex-col gap-2 rounded border border-border p-4">
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-iron">Score trends</h4>
        <ScoreTrends />
      </div>
      <PlaceholderPanel title="Promotion ledger" />
      <PlaceholderPanel title="Loop ledger" />
    </div>
  </div>
)
