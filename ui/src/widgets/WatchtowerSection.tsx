import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { SkeletonList } from '@/components/Skeleton'
import { LoopLedgerPanel } from './LoopLedgerPanel'
import { PromotionLedgerTable } from './PromotionLedgerTable'
import { WatchtowerTrendChart } from './WatchtowerTrendChart'

// ---------------------------------------------------------------------------
// Score trends subsection
// ---------------------------------------------------------------------------

const ScoreTrends = () => {
  const { data: workflows, isLoading } = useScorerWorkflows()

  if (isLoading) {
    return (
      <SkeletonList
        rows={1}
        rowClassName="h-[90px] w-full"
        label="Loading score trends"
      />
    )
  }

  if (!workflows || workflows.length === 0) {
    return <p className="text-primary text-xs">No scores yet</p>
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
// WatchtowerSection
// ---------------------------------------------------------------------------

export const WatchtowerSection = () => (
  <div className="flex flex-col gap-3">
    <h3 className="font-mono text-[11px] uppercase tracking-wide text-primary">Watchtower</h3>
    <div className="flex flex-col gap-3">
      {/* Score trends — live data via useScorerWorkflows + WatchtowerTrendChart */}
      <div className="flex flex-col gap-2 rounded border border-border p-4">
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-primary">Score trends</h4>
        <ScoreTrends />
      </div>
      <div className="flex flex-col gap-2 rounded border border-border p-4">
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-primary">Promotion ledger</h4>
        <PromotionLedgerTable />
      </div>
      <div className="flex flex-col gap-2 rounded border border-border p-4">
        <h4 className="font-mono text-[11px] uppercase tracking-wide text-primary">Loop ledger</h4>
        <LoopLedgerPanel />
      </div>
    </div>
  </div>
)
