import { useState, useMemo } from 'react'
import { useScorerWorkflows } from '@/entities/watchtower/useScorerWorkflows'
import { useLoopLedger } from '@/entities/watchtower/useLoopLedger'
import { SkeletonList } from '@/components/Skeleton'
import { useTasks } from '@/hooks/useTasks'
import { formatAbsoluteDateTime, relativeTime } from '@/shared/time'

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

  // Build an id→title map so each run row can show a human label instead of a
  // bare task id. The snapshot is almost always already cached from the Progress
  // tab, so this adds zero network requests in the common case.
  const { snapshot } = useTasks()
  const taskTitleMap = useMemo((): Map<string, string> => {
    if (!snapshot) return new Map()
    const map = new Map<string, string>()
    for (const col of Object.values(snapshot.columns)) {
      for (const t of col) {
        map.set(t.id, t.title)
      }
    }
    return map
  }, [snapshot])

  return (
    <div className="flex flex-col gap-2">
      <select
        value={workflow ?? ''}
        onChange={(e) => setSelected(e.target.value || null)}
        className="self-start rounded border border-border bg-card px-2 py-0.5 text-body"
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
        <p role="alert" className="text-error text-body">Couldn't load loop ledger</p>
      ) : entries.length === 0 ? (
        <p className="text-primary text-body">No loop runs yet</p>
      ) : (
        <table className="w-full text-body">
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
            {entries.map((entry) => {
              const title = taskTitleMap.get(entry.runId) ?? entry.runId
              return (
                <tr key={entry.runId}>
                  <td className="py-0.5 pr-2">
                    <span className="text-foreground">{title}</span>
                    {title !== entry.runId && (
                      <span
                        className="ml-1 font-mono text-micro text-muted-foreground/60"
                        title={entry.runId}
                      >
                        {entry.runId}
                      </span>
                    )}
                  </td>
                  <td className="py-0.5 pr-2" title={entry.scoredAt !== null ? formatAbsoluteDateTime(entry.scoredAt) : undefined}>
                    {entry.scoredAt !== null ? relativeTime(entry.scoredAt) : '—'}
                  </td>
                  <td className="py-0.5 pr-2">
                    {entry.score !== null ? entry.score.toFixed(2) : '—'}
                  </td>
                  <td className="py-0.5 pr-2">
                    {entry.recorded ? '✓' : '—'}
                  </td>
                  <td className="py-0.5 pr-2">
                    {entry.suggestion !== null
                      ? `${entry.suggestion.version} (${entry.suggestion.decisionKind})`
                      : '—'}
                  </td>
                  <td className="py-0.5">
                    {entry.review !== null
                      ? `${entry.review.decision} · ${relativeTime(entry.review.decidedAt)}`
                      : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
