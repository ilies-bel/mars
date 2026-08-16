/**
 * TriagePage — "Needs you" ranked triage view.
 *
 * Answers "what needs me right now" with a single ranked list of every open
 * action-queue item, ordered by priority then recency. Each row shows the
 * plain-language headline, kind chip, age, and inline resolution actions.
 *
 * Empty state: "All quiet — N running, N done today".
 */

import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useActionQueue } from '@/entities/actionQueue/useActionQueue'
import { useProgress } from '@/hooks/useProgress'
import { postDecision } from '@/shared/api'
import { formatRelativeAge } from '@/shared/time'
import type { ActionQueueItem } from '@/shared/schemas'
import type { Decision } from '@/shared/schemas'

// ── Priority ranking ──────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<ActionQueueItem['priority'], number> = {
  high: 0,
  normal: 1,
  low: 2,
}

// ── Kind display ──────────────────────────────────────────────────────────────

const KIND_ICON: Record<string, string> = {
  failed: '⚠',
  'daemon-killed': '⛔',
  'stale-queued': '⏳',
  'stale-worktree': '🗑',
  'draft-proposal': '💡',
  'awaiting-validation': '🔍',
  'arc-failed': '⛓',
  'awaiting-human': '👤',
  'coder-question': '❓',
  'diagnose-inconclusive': '🔬',
  'reflect-recommended': '✦',
  'scorer-suggested': '◈',
}

const KIND_LABEL: Record<string, string> = {
  failed: 'failed',
  'daemon-killed': 'killed',
  'stale-queued': 'stale',
  'stale-worktree': 'worktree',
  'draft-proposal': 'proposal',
  'awaiting-validation': 'validate',
  'arc-failed': 'arc failed',
  'awaiting-human': 'awaiting',
  'coder-question': 'question',
  'diagnose-inconclusive': 'inconclusive',
  'reflect-recommended': 'reflect',
  'scorer-suggested': 'scorer',
}

/** Left accent bar color per kind. */
const KIND_ACCENT: Record<string, string> = {
  failed: 'border-l-error',
  'daemon-killed': 'border-l-error',
  'arc-failed': 'border-l-error',
  'stale-queued': 'border-l-warn',
  'stale-worktree': 'border-l-warn',
  'awaiting-validation': 'border-l-trace-mars',
  'draft-proposal': 'border-l-success',
  'awaiting-human': 'border-l-primary',
}

/** Badge text + border tint per kind. */
const KIND_CHIP_CLASS: Record<string, string> = {
  failed: 'text-error border-error/40',
  'daemon-killed': 'text-error border-error/40',
  'arc-failed': 'text-error border-error/40',
  'stale-queued': 'text-warn border-warn/40',
  'stale-worktree': 'text-warn border-warn/40',
  'awaiting-validation': 'text-trace-mars border-trace-mars/40',
  'draft-proposal': 'text-success border-success/40',
}

// ── Sort ──────────────────────────────────────────────────────────────────────

function sortItems(items: ActionQueueItem[]): ActionQueueItem[] {
  return [...items].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 1
    const pb = PRIORITY_ORDER[b.priority] ?? 1
    if (pa !== pb) return pa - pb
    // Within same priority, most-recent first
    return b.at.localeCompare(a.at)
  })
}

// ── TriageRow ─────────────────────────────────────────────────────────────────

interface TriageRowProps {
  item: ActionQueueItem
}

const TriageRow = ({ item }: TriageRowProps) => {
  const qc = useQueryClient()
  const [pending, setPending] = useState<string | null>(null)
  const [resolved, setResolved] = useState(false)

  const age = formatRelativeAge(Date.now() - new Date(item.at).getTime())
  const headline = item.humanSummary || item.title
  const goal = item.arcGoal ?? null
  const accentClass = KIND_ACCENT[item.kind] ?? 'border-l-muted'
  const kindLabel = KIND_LABEL[item.kind] ?? item.kind
  const kindIcon = KIND_ICON[item.kind] ?? '•'
  const chipClass =
    KIND_CHIP_CLASS[item.kind] ?? 'text-muted-foreground border-border'

  const handleDecision = useCallback(
    async (d: Decision) => {
      if (pending !== null) return
      setPending(d.label)
      try {
        await postDecision(d)
        setResolved(true)
        void qc.invalidateQueries({ queryKey: ['action-queue'] })
      } catch {
        setPending(null)
      }
    },
    [pending, qc],
  )

  if (resolved) return null

  return (
    <div
      className={[
        'mars-card relative border-l-2 px-4 py-3 transition-opacity',
        accentClass,
      ].join(' ')}
    >
      {/* Top row: kind chip + priority badge + age */}
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={[
            'rounded border px-1.5 py-0.5 font-mono text-[9px] leading-none',
            chipClass,
          ].join(' ')}
        >
          {kindIcon} {kindLabel}
        </span>
        {item.priority === 'high' && (
          <span className="rounded bg-error/10 px-1.5 py-0.5 font-mono text-[9px] leading-none text-error">
            high
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {age}
        </span>
      </div>

      {/* Headline */}
      {headline && (
        <p className="mb-0.5 text-[12px] font-medium leading-snug text-foreground">
          {headline}
        </p>
      )}

      {/* Arc goal (task intent) — shown when it differs from the headline */}
      {goal && goal !== headline && (
        <p className="mb-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {goal}
        </p>
      )}

      {/* Entity ID */}
      <p className="mb-2 font-mono text-[10px] text-neutral-500">
        {item.entityId}
      </p>

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-2">
        {item.decisions.slice(0, 3).map((d) => (
          <button
            key={d.label}
            disabled={pending !== null}
            onClick={() => void handleDecision(d)}
            className="rounded border border-primary/40 px-2 py-1 font-mono text-[10px] text-foreground transition-colors hover:bg-primary/20 disabled:opacity-50"
          >
            {pending === d.label ? '…' : d.label}
          </button>
        ))}
        <a
          href="#/chat"
          className="ml-auto font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Chat →
        </a>
      </div>
    </div>
  )
}

// ── EmptyState ────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  running: number
  doneToday: number
}

const EmptyState = ({ running, doneToday }: EmptyStateProps) => (
  <div className="flex flex-col items-center justify-center py-24 text-center">
    <span
      className="mb-3 text-[32px] opacity-20"
      style={{ color: 'var(--color-amber)' }}
      aria-hidden="true"
    >
      ◆
    </span>
    <p className="mb-1 text-[14px] font-medium text-foreground">All quiet</p>
    <p className="font-mono text-[11px] text-muted-foreground">
      {running > 0 ? `${running} running` : 'nothing running'}
      {doneToday > 0 ? ` · ${doneToday} done today` : ''}
    </p>
  </div>
)

// ── TriagePage ────────────────────────────────────────────────────────────────

export const TriagePage = () => {
  const { items, error } = useActionQueue()
  const { byCluster, aggregates } = useProgress()

  const running = byCluster['In progress'].length
  const doneToday = aggregates.doneToday

  const sorted = sortItems(items)

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-[11px] text-error">
          Failed to load action queue
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header strip */}
      <div className="flex shrink-0 items-center border-b border-border px-5 py-3">
        <h1 className="font-mono text-[13px] font-semibold text-foreground">
          Needs you
        </h1>
        {sorted.length > 0 && (
          <span
            aria-label={`${sorted.length} items need attention`}
            className="ml-2 rounded-full bg-primary/20 px-2 py-0.5 font-mono text-[9px] leading-none text-primary"
          >
            {sorted.length}
          </span>
        )}
        <a
          href="#/chat"
          className="ml-auto font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Chat →
        </a>
      </div>

      {/* Ranked list */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <EmptyState running={running} doneToday={doneToday} />
        ) : (
          <div className="flex flex-col gap-2 p-4">
            {sorted.map((item) => (
              <TriageRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
