import { useQuery } from '@tanstack/react-query'
import { CollapsibleSection } from './CollapsibleSection'

// Mirror the BASE constant pattern used across ui/src/shared/api.ts.
const BASE = import.meta.env.VITE_API_BASE ?? ''

interface DomainFlowResponse {
  rendered: string
}

/**
 * Fetch the Domain Flow for an arc from the daemon.
 *
 * Returns `null` when no flow has been recorded for the arc (HTTP 404).
 * Throws on unexpected errors so React Query can surface them.
 */
const fetchDomainFlow = async (arcId: string): Promise<DomainFlowResponse | null> => {
  const r = await fetch(`${BASE}/view/domain-flow/${encodeURIComponent(arcId)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`domain-flow: unexpected status ${r.status}`)
  return r.json() as Promise<DomainFlowResponse>
}

interface Props {
  arcId: string
}

/**
 * Collapsible panel that shows the Domain Flow diagram for an arc.
 *
 * Fetches `GET /view/domain-flow/:arcId` on mount; renders nothing when the
 * arc has no recorded flow (404) or while the request is still in flight.
 */
export const DomainFlowPanel = ({ arcId }: Props) => {
  const { data } = useQuery({
    queryKey: ['domain-flow', arcId],
    queryFn: () => fetchDomainFlow(arcId),
    staleTime: 60_000,
  })

  // data is undefined while loading, null when no flow exists.
  if (!data) return null

  return (
    // `relative z-10` raises this above the stretched-link ::before pseudo-element
    // in TaskCard so the <details> toggle receives its own pointer events.
    <div className="relative z-10 border-t border-border/50 pt-2">
      <CollapsibleSection label="Domain Flow" defaultOpen data-testid="domain-flow-panel">
        <div className="whitespace-pre-wrap font-mono text-label text-foreground">
          {data.rendered}
        </div>
      </CollapsibleSection>
    </div>
  )
}
