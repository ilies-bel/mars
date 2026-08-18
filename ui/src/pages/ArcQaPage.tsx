/**
 * ArcQaPage — per-arc QA walk viewer.
 *
 * Route: #/arc/<originId>/qa
 * API:   GET /arc/<originId>/qa
 *
 * Renders one collapsible section per Criterion, with numbered steps.
 * Each step expands to show the screenshot captured at that moment.
 * The stopped step is auto-expanded and badged with the stop reason.
 *
 * On 404 from the API the page shows "No QA walk recorded for this Arc."
 */

import { useQuery } from '@tanstack/react-query'
import { ErrorState } from '@/components/ErrorState'
import { SkeletonList } from '@/components/Skeleton'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Step {
  index: number
  text: string
}

interface Criterion {
  text: string
  steps: Step[]
}

export interface ArcQaData {
  criteria: Criterion[]
  stoppedAtStep: {
    criterionIndex: number
    stepIndex: number
    stopReason: string
  } | null
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const fetchArcQa = async (originId: string): Promise<ArcQaData | null> => {
  const res = await fetch(`/arc/${encodeURIComponent(originId)}/qa`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<ArcQaData>
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ArcQaPageProps {
  originId: string
}

export const ArcQaPage = ({ originId }: ArcQaPageProps) => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['arc-qa', originId],
    queryFn: () => fetchArcQa(originId),
  })

  if (isLoading || data === undefined) {
    return (
      <main className="flex h-full flex-1 flex-col bg-background p-4">
        <SkeletonList rows={4} rowClassName="h-12 w-full mb-3" label="Loading QA walk" />
      </main>
    )
  }

  if (error) {
    return (
      <main className="flex h-full flex-1 flex-col bg-background p-4">
        <ErrorState error={error} of="QA data" variant="inline" />
      </main>
    )
  }

  if (data === null) {
    return (
      <main className="flex h-full flex-1 flex-col bg-background p-4">
        <p className="text-label text-muted-foreground">No QA walk recorded for this Arc.</p>
      </main>
    )
  }

  const stopped = data.stoppedAtStep

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-background p-4">
      <h1 className="font-semibold text-foreground">Arc QA</h1>
      <p className="font-mono text-micro text-muted-foreground">{originId}</p>
      <div className="flex flex-col gap-4">
        {data.criteria.map((criterion, ci) => {
          const isStoppedCriterion = stopped !== null && stopped.criterionIndex === ci
          return (
            <details
              key={ci}
              open={isStoppedCriterion}
              data-testid={`criterion-${ci}`}
            >
              <summary className="cursor-pointer select-none rounded px-2 py-1 text-label font-medium text-foreground hover:bg-primary/10">
                {criterion.text}
              </summary>
              <ol className="mt-1 flex flex-col gap-1 pl-4">
                {criterion.steps.map((step) => {
                  const si = step.index
                  const isStopped = isStoppedCriterion && stopped.stepIndex === si
                  return (
                    <li key={si}>
                      <details
                        open={isStopped}
                        data-testid={`step-${ci}-${si}`}
                      >
                        <summary className="flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 text-label text-foreground hover:bg-primary/10">
                          <span className="font-mono text-micro text-muted-foreground">
                            {si + 1}.
                          </span>
                          <span className="flex-1">{step.text}</span>
                          {isStopped && stopped.stopReason && (
                            <span
                              className="rounded px-1 font-mono text-micro text-error"
                              data-testid={`stop-reason-${ci}-${si}`}
                            >
                              {stopped.stopReason}
                            </span>
                          )}
                        </summary>
                        <div className="mt-1 px-2">
                          <img
                            src={`/arc/${encodeURIComponent(originId)}/qa/screenshot/${ci}/${si}`}
                            alt={`Screenshot for step ${si + 1} of criterion ${ci + 1}`}
                            className="max-w-full rounded"
                            data-testid={`screenshot-${ci}-${si}`}
                          />
                        </div>
                      </details>
                    </li>
                  )
                })}
              </ol>
            </details>
          )
        })}
      </div>
    </main>
  )
}
