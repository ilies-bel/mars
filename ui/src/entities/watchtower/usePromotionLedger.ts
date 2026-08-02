import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { appendProject, fetchJson } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'

// ---------------------------------------------------------------------------
// Server response schema — matches GET /view/promotion-ledger
// (daemon: viewPromotionLedger → { entries: PromotionLedgerEntry[] })
// Mirrors orchestrator/src/core/promotion-ledger.ts PromotionLedgerEntrySchema.
// ---------------------------------------------------------------------------

const PromotionLedgerEntrySchema = z.object({
  id: z.string(),
  workflow: z.string(),
  candidateVersionId: z.string(),
  incumbentVersionId: z.string(),
  candidateScore: z.number().nullable(),
  incumbentScore: z.number().nullable(),
  candidateN: z.number(),
  incumbentN: z.number(),
  decision: z.enum(['promoted', 'retired', 'pending']),
  decidedAt: z.number().nullable(),
  createdAt: z.number(),
})

export type PromotionLedgerEntry = z.infer<typeof PromotionLedgerEntrySchema>

const responseSchema = z.object({
  entries: z.array(PromotionLedgerEntrySchema),
})

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

interface PromotionLedgerState {
  entries: PromotionLedgerEntry[]
  isLoading: boolean
  error: Error | null
}

/**
 * Fetches the promotion gate decision history, optionally filtered by workflow
 * kind, from GET /api/promotion-ledger. Entries are ordered newest first.
 */
export const usePromotionLedger = (workflow?: string): PromotionLedgerState => {
  const projectId = useFocusedProjectId()
  const query = useQuery({
    queryKey: ['promotion-ledger', projectId, workflow],
    queryFn: () => {
      const qs = workflow ? `?workflow=${encodeURIComponent(workflow)}` : ''
      return fetchJson(
        appendProject(`/api/promotion-ledger${qs}`, projectId ?? undefined),
        responseSchema,
      )
    },
  })

  return {
    entries: query.data?.entries ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
