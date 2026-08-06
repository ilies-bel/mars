import { useState } from 'react'
import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useScorerSuggestions } from '@/entities/watchtower/useScorerSuggestions'
import { useAcceptScorer } from '@/entities/watchtower/useAcceptScorer'
import type { SuggestedScorer } from '@/entities/watchtower/useScorerSuggestions'
import { SkeletonList } from '@/components/Skeleton'
import { LoopLedgerPanel } from './LoopLedgerPanel'
import { PromotionLedgerTable } from './PromotionLedgerTable'
import { WatchtowerTrendChart } from './WatchtowerTrendChart'

// ---------------------------------------------------------------------------
// SuggestedScorersPanel
//
// Shown when no scorer results exist yet — i.e. no scorer has been accepted.
// Surfaces the pending suggestions with name, workflow, confidence, rubric,
// and an Accept button for each. A confirmation step guards the button so an
// accidental click cannot accept a scorer unintentionally.
// ---------------------------------------------------------------------------

const ConfidenceBadge = ({ value }: { value: number }) => {
  const pct = Math.round(value * 100)
  const colour =
    value >= 0.9
      ? 'text-green-600 dark:text-green-400'
      : value >= 0.7
        ? 'text-yellow-600 dark:text-yellow-400'
        : 'text-muted-foreground'
  return (
    <span className={`font-mono text-[10px] tabular-nums ${colour}`}>
      {pct}%
    </span>
  )
}

interface AcceptButtonProps {
  scorer: SuggestedScorer
  accept: (id: string) => void
  isPending: boolean
}

const AcceptButton = ({ scorer, accept, isPending }: AcceptButtonProps) => {
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground">
          Future {scorer.workflow} tasks will be graded. Record-only — not a merge gate.
        </span>
        <button
          onClick={() => {
            accept(scorer.id)
            setConfirming(false)
          }}
          disabled={isPending}
          className="rounded border border-primary px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/10 disabled:opacity-50"
          aria-label={`Confirm accepting scorer: ${scorer.title}`}
        >
          {isPending ? 'Accepting…' : 'Confirm'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted"
          aria-label="Cancel accept"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      disabled={isPending}
      className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
      aria-label={`Accept scorer: ${scorer.title}`}
    >
      Accept
    </button>
  )
}

interface SuggestedScorersPanelProps {
  scorers: SuggestedScorer[]
}

const SuggestedScorersPanel = ({ scorers }: SuggestedScorersPanelProps) => {
  const { accept, isPending } = useAcceptScorer()

  if (scorers.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No scores yet and no pending suggestions. Run a deep reflection to
        surface quality dimensions worth grading.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Explanation banner */}
      <div
        className="rounded border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        role="status"
        aria-label="No accepted scorers — scoring is inactive"
      >
        <p>
          <strong className="text-primary">0 accepted scorers — nothing is graded.</strong>{' '}
          Accepting a scorer grades every subsequent merged task of that workflow
          against its rubric, record-only. The low-trend auto-reflect trigger
          cannot fire until at least one scorer is accepted.
        </p>
      </div>

      {/* Suggestion list */}
      <ul className="flex flex-col gap-2" aria-label="Pending scorer suggestions">
        {scorers.map((scorer) => (
          <li
            key={scorer.id}
            className="rounded border border-border p-3 flex flex-col gap-1.5"
            data-scorer-id={scorer.id}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] font-medium text-primary truncate">
                  {scorer.title}
                </span>
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {scorer.workflow}
                </span>
                <ConfidenceBadge value={scorer.confidence} />
              </div>
              <AcceptButton scorer={scorer} accept={accept} isPending={isPending} />
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3">
              {scorer.rubric}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Score trends subsection
// ---------------------------------------------------------------------------

const ScoreTrends = () => {
  const { data: workflows, isLoading: workflowsLoading } = useScorerWorkflows()
  const { scorers: suggestions, isLoading: suggestionsLoading } = useScorerSuggestions()

  if (workflowsLoading || suggestionsLoading) {
    return (
      <SkeletonList
        rows={1}
        rowClassName="h-[90px] w-full"
        label="Loading score trends"
      />
    )
  }

  // At least one workflow has recorded results — show the live charts.
  if (workflows && workflows.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        {workflows.map((kind) => (
          <WatchtowerTrendChart key={kind} workflow={kind} window={20} />
        ))}
      </div>
    )
  }

  // No results yet — show pending suggestions (or the no-suggestions fallback).
  return <SuggestedScorersPanel scorers={suggestions} />
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
