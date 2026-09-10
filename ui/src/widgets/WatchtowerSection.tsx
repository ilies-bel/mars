import { SectionHeading } from '@/widgets/primitives/DensityPrimitives'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useScorerSuggestions } from '@/entities/watchtower/useScorerSuggestions'
import { useAcceptScorer } from '@/entities/watchtower/useAcceptScorer'
import type { SuggestedScorer } from '@/entities/watchtower/useScorerSuggestions'
import { SkeletonList } from '@/components/Skeleton'
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
      ? 'text-success'
      : value >= 0.7
        ? 'text-warn'
        : 'text-muted-foreground'
  return (
    <span className={`text-micro tabular-nums ${colour}`}>
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
        <span className="text-micro text-muted-foreground">
          Future {scorer.workflow} tasks will be graded. Record-only — not a merge gate.
        </span>
        <button
          onClick={() => {
            accept(scorer.id)
            setConfirming(false)
          }}
          disabled={isPending}
          className="rounded border border-highlight/40 bg-highlight/10 px-1.5 py-0.5 text-micro font-medium text-foreground hover:bg-highlight/20 disabled:opacity-50"
          aria-label={`Confirm accepting scorer: ${scorer.title}`}
        >
          {isPending ? 'Accepting…' : 'Confirm'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="rounded border border-border px-1.5 py-0.5 text-micro text-muted-foreground hover:bg-muted"
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
      className="rounded border border-border px-1.5 py-0.5 text-micro text-muted-foreground hover:border-highlight/50 hover:text-foreground disabled:opacity-50"
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
      <p className="text-body text-muted-foreground">
        No scores. Run a deep reflection to generate scorer suggestions.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Explanation banner */}
      <div
        className="rounded border border-border bg-muted/30 px-3 py-2 text-body text-muted-foreground"
        role="status"
        aria-label="No accepted scorers — scoring is inactive"
      >
        <p>
          <strong className="text-muted-foreground">0 accepted scorers — nothing is graded.</strong>{' '}
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
                <span className="text-label font-medium text-muted-foreground truncate">
                  {scorer.title}
                </span>
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-micro text-muted-foreground">
                  {scorer.workflow}
                </span>
                <ConfidenceBadge value={scorer.confidence} />
              </div>
              <AcceptButton scorer={scorer} accept={accept} isPending={isPending} />
            </div>
            <p className="text-label text-muted-foreground leading-relaxed line-clamp-3">
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
    <SectionHeading>Improvement loop</SectionHeading>
    <div className="flex flex-col gap-3">
      {/* Score trends — live data via useScorerWorkflows + WatchtowerTrendChart */}
      <div className="flex flex-col gap-2 rounded border border-border p-4">
        <h4 className="panel-title">Score trends</h4>
        <ScoreTrends />
      </div>
      <div className="flex flex-col gap-2 rounded border border-border p-4">
        <h4 className="panel-title">Promoted helpers</h4>
        <PromotionLedgerTable />
      </div>
      {/* The scored runs themselves live on #/scores, once.
          This panel used to render them a second time here — LoopLedgerPanel's
          Run / Scored at / Score / Recorded over the same rows the Scores page
          lists as Task / Scored / Score. Two tables of one dataset on two
          pages, and a reader could not tell which was authoritative. KPI keeps
          the trend, which is the thing a KPI page is for, and hands over. */}
      {/* A full-width bordered box with grey placeholder-weight text at the
          left and a faint glyph at the right reads as a disabled search
          field, not a link — which is what this was. A destination gets a
          name in foreground weight and a chevron that points somewhere. */}
      <a
        href="#/studio"
        data-testid="scores-handoff"
        className="group flex items-center gap-2 rounded border border-border px-4 py-3 transition-colors hover:bg-foreground/5"
      >
        <div className="flex min-w-0 flex-col">
          <span className="text-title font-medium text-foreground">Scores</span>
          <span className="text-label text-muted-foreground">
            Every scored run, worst first
          </span>
        </div>
        <ChevronRight
          size={16}
          strokeWidth={2}
          aria-hidden="true"
          className="ml-auto shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        />
      </a>
    </div>
  </div>
)
