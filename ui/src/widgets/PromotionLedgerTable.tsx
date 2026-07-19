import { Fragment, useState } from 'react'
import { usePromotionLedger } from '@/entities/watchtower/usePromotionLedger'

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
 */
export const PromotionLedgerTable = ({ workflow }: Props) => {
  const { entries, isLoading } = usePromotionLedger(workflow)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (isLoading) return null

  if (entries.length === 0) {
    return <p className="text-iron text-xs">No promotions yet</p>
  }

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-iron">
          <th className="pb-1 pr-2 font-normal">Timestamp</th>
          <th className="pb-1 pr-2 font-normal">Workflow</th>
          <th className="pb-1 pr-2 font-normal">Decision</th>
          <th className="pb-1 pr-2 font-normal">Versions</th>
          <th className="pb-1 font-normal">Scores</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <Fragment key={entry.id}>
            <tr
              className="cursor-pointer hover:bg-surface-hover"
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
                  <pre className="overflow-auto rounded bg-surface p-2 text-[10px]">
                    {JSON.stringify(entry, null, 2)}
                  </pre>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}
