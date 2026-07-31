import { useQuery } from '@tanstack/react-query'
import { fetchStewardLedger } from '@/shared/api'
import type { StewardLedgerEntry } from '@/shared/schemas'

export interface StewardLedgerPanelProps {
  /** Restricts the ledger to one durable target when both fields are present. */
  targetKind?: string
  targetId?: string
}

/**
 * Read-only evidence trail for interventions made by Steward. The daemon owns
 * ordering, and the display repeats it defensively so an out-of-order response
 * never tells the operator the wrong story.
 */
export const StewardLedgerPanel = ({ targetKind, targetId }: StewardLedgerPanelProps) => {
  const { data, isPending, isError } = useQuery<StewardLedgerEntry[]>({
    queryKey: ['steward-ledger', targetKind ?? null, targetId ?? null],
    queryFn: () => fetchStewardLedger(targetKind, targetId),
    retry: false,
  })
  const entries = (data ?? []).slice().sort((a, b) => b.ts.localeCompare(a.ts))
  const targetLabel = targetKind && targetId ? `${targetKind} ${targetId}` : 'all targets'

  return (
    <section
      id={targetKind === undefined && targetId === undefined ? 'steward-ledger' : undefined}
      data-testid="steward-ledger-panel"
      data-target-kind={targetKind}
      data-target-id={targetId}
      className="border-t border-primary/20 px-4 py-3"
    >
      <h3 className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
        Steward timeline · {targetLabel}
      </h3>
      {isPending ? (
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">Loading Steward timeline…</p>
      ) : isError ? (
        <p className="mt-2 font-mono text-[11px] text-error/80">Could not load Steward interventions.</p>
      ) : entries.length === 0 ? (
        <p data-testid="steward-ledger-empty" className="mt-2 font-mono text-[11px] text-muted-foreground">
          No Steward interventions recorded.
        </p>
      ) : (
        <ol className="mt-3 flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-testid="steward-ledger-row"
              className="rounded border border-primary/20 bg-card px-3 py-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 font-mono text-[11px]">
                <span className="font-semibold text-foreground">{entry.targetKind} {entry.targetId}</span>
                <time dateTime={entry.ts} className="text-muted-foreground">{entry.ts}</time>
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-[10px] leading-relaxed">
                <dt className="text-muted-foreground">Recipe</dt><dd className="break-all text-foreground">{entry.recipeId}</dd>
                <dt className="text-muted-foreground">Version</dt><dd className="break-all text-foreground">{entry.targetVersion}</dd>
                <dt className="text-muted-foreground">Rationale</dt><dd className="text-foreground">{entry.rationale}</dd>
                <dt className="text-muted-foreground">Outcome</dt><dd className="text-foreground">{entry.outcome}</dd>
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
          ))}
        </ol>
      )}
    </section>
  )
}
