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
 * The <thead> is always rendered so the table box stays the same size while
 * loading — only <tbody> is gated behind isLoading / empty-state checks.
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

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-primary">
          <th className="pb-1 pr-2 font-normal">Timestamp</th>
          <th className="pb-1 pr-2 font-normal">Workflow</th>
          <th className="pb-1 pr-2 font-normal">Decision</th>
          <th className="pb-1 pr-2 font-normal">Versions</th>
          <th className="pb-1 font-normal">Scores</th>
        </tr>
      </thead>
      <tbody>
        {isLoading ? (
          <tr>
            <td colSpan={5}>
              <SkeletonList rows={3} rowClassName="h-5 w-full mb-1" label="Loading promotions" />
            </td>
          </tr>
        ) : error ? (
          <tr>
            <td colSpan={5} role="alert" className="py-1 text-error">Couldn't load promotions</td>
          </tr>
        ) : entries.length === 0 ? (
          <tr>
            <td colSpan={5} className="py-1 text-primary">No promotions yet</td>
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
                <td className="py-0.5 pr-2 font-mono text-[10px]">
                  {entry.candidateVersionId} → {entry.incumbentVersionId}
                </td>
                <td className="py-0.5">
                  {fmtScore(entry.candidateScore)} vs {fmtScore(entry.incumbentScore)}
                </td>
              </tr>
              {expanded.has(entry.id) && (
                <tr>
                  <td colSpan={5}>
                    <pre className="overflow-auto rounded bg-card p-2 text-[10px]">
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
