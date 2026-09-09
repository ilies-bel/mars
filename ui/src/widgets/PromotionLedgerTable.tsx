import { Fragment, useState } from 'react'
import { usePromotionLedger } from '@/entities/watchtower/usePromotionLedger'
import { SkeletonList } from '@/components/Skeleton'

interface Props {
  workflow?: string
}

const formatTs = (ms: number): string =>
  new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

const fmtScore = (n: number | null): string => (n === null ? '–' : n.toFixed(2))

/**
 * Renders a table of every promotion gate decision, newest first.
 *
 * Columns: Timestamp | Workflow | Decision | Versions (candidate → incumbent) | Scores
 *
 * Clicking any row toggles an inline evidence panel underneath that
 * pretty-prints the full ledger entry as JSON.
 *
 * The <thead> stays rendered while LOADING, so the table box does not change
 * size when rows arrive. It is NOT rendered when the ledger is genuinely
 * empty: five column headers standing over the words "No promotions yet" is a
 * scaffold pretending to be data, and it made the panel read as broken rather
 * than as empty.
 */
export const PromotionLedgerTable = ({ workflow }: Props) => {
  const { entries, isLoading, error } = usePromotionLedger(workflow)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Genuinely empty is a different state from loading: there are no rows
  // coming, so there is no layout shift to protect against and no reason to
  // draw a header for columns that will never be filled.
  if (!isLoading && !error && entries.length === 0) {
    return <p className="text-body text-muted-foreground">No promotions yet</p>
  }
  if (error) {
    return (
      <p role="alert" className="text-body text-error">
        Couldn&apos;t load promotions
      </p>
    )
  }

  return (
    <table className="w-full text-body">
      <thead>
        <tr className="eyebrow text-left text-muted-foreground">
          <th className="whitespace-nowrap pb-1 pr-2">Timestamp</th>
          <th className="whitespace-nowrap pb-1 pr-2">Workflow</th>
          <th className="whitespace-nowrap pb-1 pr-2">Decision</th>
          <th className="whitespace-nowrap pb-1 pr-2">Versions</th>
          <th className="whitespace-nowrap pb-1">Scores</th>
        </tr>
      </thead>
      <tbody>
        {isLoading ? (
          <tr>
            <td colSpan={5}>
              <SkeletonList rows={3} rowClassName="h-5 w-full mb-1" label="Loading promotions" />
            </td>
          </tr>
        ) : (
          entries.map((entry) => (
            <Fragment key={entry.id}>
              <tr
                className="cursor-pointer hover:bg-card-hover"
                onClick={() => toggle(entry.id)}
              >
                <td className="py-0.5 pr-2 font-mono">{formatTs(entry.createdAt)}</td>
                <td className="py-0.5 pr-2">{entry.workflow}</td>
                <td className="py-0.5 pr-2">{entry.decision}</td>
                <td className="py-0.5 pr-2 text-micro">
                  {entry.candidateVersionId} → {entry.incumbentVersionId}
                </td>
                <td className="py-0.5">
                  {fmtScore(entry.candidateScore)} vs {fmtScore(entry.incumbentScore)}
                </td>
              </tr>
              {expanded.has(entry.id) && (
                <tr>
                  <td colSpan={5}>
                    <pre className="overflow-auto rounded bg-card p-2 text-micro">
                      {JSON.stringify(entry, null, 2)}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))
        )}
      </tbody>
    </table>
  )
}
