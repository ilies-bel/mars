import { useState } from 'react'
import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useLoopLedger } from '@/entities/watchtower/useLoopLedger'
import { SkeletonList } from '@/components/Skeleton'

const formatTs = (ms: number): string =>
  new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

/**
 * Renders the Loop ledger subsection of the Watchtower panel.
 *
 * A workflow-kind <select> (defaulting to the first known workflow) sits above
 * a table with columns [Run, Scored at, Score, Recorded, Suggest, Review].
 * Each row corresponds to one pass through the run→score→record→suggest→review
 * loop. Stages that have not yet completed render '—'.
 *
 * The <select> depends only on `workflows`, not the ledger query, so it is
 * rendered unconditionally. The isLoading guard is moved to the table body
 * so the workflow selector stays visible while ledger data loads.
 */
export const LoopLedgerPanel = () => {
  const { data: workflows } = useScorerWorkflows()

  // `selected` is the user's explicit pick; null means "use the first workflow
  // from the list" so the panel auto-populates when workflows first load.
  const [selected, setSelected] = useState<string | null>(null)
  const workflow = selected ?? workflows?.[0] ?? null

  const { entries, isLoading, error } = useLoopLedger(workflow)

  return (
    <div className="flex flex-col gap-2">
      <select
        value={workflow ?? ''}
        onChange={(e) => setSelected(e.target.value || null)}
        className="self-start rounded border border-border bg-card px-2 py-0.5 text-xs"
      >
        {(workflows ?? []).map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </select>
      {isLoading ? (
        <SkeletonList rows={3} rowClassName="h-5 w-full mb-1" label="Loading loop ledger" />
      ) : error ? (
        <p role="alert" className="text-error text-xs">Couldn't load loop ledger</p>
      ) : entries.length === 0 ? (
        <p className="text-primary text-xs">No loop runs yet</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-primary">
              <th className="pb-1 pr-2 font-normal">Run</th>
              <th className="pb-1 pr-2 font-normal">Scored at</th>
              <th className="pb-1 pr-2 font-normal">Score</th>
              <th className="pb-1 pr-2 font-normal">Recorded</th>
              <th className="pb-1 pr-2 font-normal">Suggest</th>
              <th className="pb-1 font-normal">Review</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.runId}>
                <td className="py-0.5 pr-2 font-mono">{entry.runId}</td>
                <td className="py-0.5 pr-2 font-mono">
                  {entry.scoredAt !== null ? formatTs(entry.scoredAt) : '—'}
                </td>
                <td className="py-0.5 pr-2">
                  {entry.score !== null ? entry.score.toFixed(2) : '—'}
                </td>
                <td className="py-0.5 pr-2 font-mono">
                  {entry.recordedAt !== null ? formatTs(entry.recordedAt) : '—'}
                </td>
                <td className="py-0.5 pr-2">{entry.suggestion?.version ?? '—'}</td>
                <td className="py-0.5">{entry.review?.decision ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
