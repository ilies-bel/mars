import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchStewardLedger } from '@/shared/api'
import type { StewardLedgerEntry } from '@/shared/schemas'
import { smartTimestamp, formatFailureSig } from '@/shared/displayStrings'
import { Response } from '@/components/chat-primitives/response'

export interface StewardLedgerPanelProps {
  /** Restricts the ledger to one durable target when both fields are present. */
  targetKind?: string
  targetId?: string
}

const INITIAL_VISIBLE = 20

/**
 * Try to parse the outcome field as JSON. When it succeeds and the object
 * carries a `state` key, surface that as a capitalised human label and hide
 * the full object behind a disclosure. When the field is plain text, return it
 * verbatim.
 */
function parseOutcome(raw: string): { label: string; detail: string | null } {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const state = typeof obj.state === 'string' ? obj.state : null
    const label = state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Done'
    return { label, detail: JSON.stringify(obj, null, 2) }
  } catch {
    return { label: raw, detail: null }
  }
}

/**
 * Read-only evidence trail for interventions made by Steward. The daemon owns
 * ordering, and the display repeats it defensively so an out-of-order response
 * never tells the operator the wrong story.
 *
 * First paint is bounded to INITIAL_VISIBLE entries; a "Show more" affordance
 * loads the next page in place without a separate route.
 */
export const StewardLedgerPanel = ({ targetKind, targetId }: StewardLedgerPanelProps) => {
  const { data, isPending, isError } = useQuery<StewardLedgerEntry[]>({
    queryKey: ['steward-ledger', targetKind ?? null, targetId ?? null],
    queryFn: () => fetchStewardLedger(targetKind, targetId),
    retry: false,
  })
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE)
  const entries = (data ?? []).slice().sort((a, b) => b.ts.localeCompare(a.ts))
  const visible = entries.slice(0, visibleCount)
  const remaining = entries.length - visibleCount
  const targetLabel = targetKind && targetId ? `${targetKind} ${targetId}` : 'all targets'

  return (
    <section
      id={targetKind === undefined && targetId === undefined ? 'steward-ledger' : undefined}
      data-testid="steward-ledger-panel"
      data-target-kind={targetKind}
      data-target-id={targetId}
      className="border-t border-primary/20 px-4 py-3"
    >
      <h3 className="font-mono text-label uppercase tracking-[0.1em] text-muted-foreground">
        Steward timeline · {targetLabel}
      </h3>
      {isPending ? (
        <p className="mt-2 font-mono text-label text-muted-foreground">Loading Steward timeline…</p>
      ) : isError ? (
        <p className="mt-2 font-mono text-label text-error/80">Could not load Steward interventions.</p>
      ) : entries.length === 0 ? (
        <p data-testid="steward-ledger-empty" className="mt-2 font-mono text-label text-muted-foreground">
          No Steward interventions recorded.
        </p>
      ) : (
        <>
          <ol className="mt-3 flex flex-col gap-2">
            {visible.map((entry) => {
              const { label: outcomeLabel, detail: outcomeDetail } = parseOutcome(entry.outcome)
              return (
                <li
                  key={entry.id}
                  data-testid="steward-ledger-row"
                  className="rounded border border-primary/20 bg-card px-3 py-2"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 font-mono text-label">
                    <span className="font-semibold text-foreground" title={entry.targetId}>
                      {entry.targetKind.charAt(0).toUpperCase() + entry.targetKind.slice(1)}{' '}
                      <span className="font-mono">{entry.targetId}</span>
                    </span>
                    <time dateTime={entry.ts} className="text-muted-foreground" title={entry.ts}>
                      {smartTimestamp(entry.ts)}
                    </time>
                  </div>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-micro leading-relaxed">
                    <dt className="text-muted-foreground">Recipe</dt>
                    <dd className="break-all text-foreground" title={entry.recipeId}>
                      {/[:/]/.test(entry.recipeId)
                        ? formatFailureSig(entry.recipeId)
                        : entry.recipeId.replace(/-/g, ' ')}
                    </dd>
                    <dt className="text-muted-foreground">Version</dt>
                    <dd className="break-all text-foreground">{entry.targetVersion}</dd>
                    <dt className="text-muted-foreground">Rationale</dt>
                    <dd className="text-foreground">
                      {/* Rendered as markdown — Rationale is agent-authored prose that may
                          contain headers, bold, backtick code spans, and lists. */}
                      <div
                        data-testid="steward-rationale-markdown"
                        className="chat-markdown prose prose-sm prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                      >
                        <Response>{entry.rationale}</Response>
                      </div>
                    </dd>
                    <dt className="text-muted-foreground">Outcome</dt>
                    <dd className="text-foreground">
                      {/* Human-readable label derived from JSON state field.
                          Full technical payload is behind a disclosure (ADR DEC-18). */}
                      <span data-testid="steward-outcome-label">{outcomeLabel}</span>
                      {outcomeDetail !== null && (
                        <details className="mt-1">
                          <summary className="cursor-pointer select-none font-mono text-micro text-muted-foreground hover:text-foreground">
                            Technical details
                          </summary>
                          <pre
                            data-testid="steward-outcome-detail"
                            className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-micro text-muted-foreground/70"
                          >
                            {outcomeDetail}
                          </pre>
                        </details>
                      )}
                    </dd>
                    {entry.commitSha !== null ? (
                      <>
                        <dt className="text-muted-foreground">Commit</dt>
                        <dd>
                          <a
                            href={`https://github.com/search?q=${encodeURIComponent(entry.commitSha)}&type=commits`}
                            className="text-primary underline underline-offset-2 hover:text-foreground"
                          >
                            {entry.commitSha}
                          </a>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </li>
              )
            })}
          </ol>
          {remaining > 0 && (
            <button
              data-testid="steward-ledger-show-more"
              onClick={() => setVisibleCount((c) => c + INITIAL_VISIBLE)}
              className="mt-3 w-full rounded border border-primary/20 px-3 py-2 font-mono text-label text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
            >
              Show more ({remaining} remaining)
            </button>
          )}
        </>
      )}
    </section>
  )
}
