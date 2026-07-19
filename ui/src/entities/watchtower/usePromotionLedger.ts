import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

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
 * kind, from GET /view/promotion-ledger. Entries are ordered newest first.
 */
export const usePromotionLedger = (workflow?: string): PromotionLedgerState => {
  const query = useQuery({
    queryKey: ['promotion-ledger', workflow],
    queryFn: async () => {
      const qs = workflow ? `?workflow=${encodeURIComponent(workflow)}` : ''
      const res = await fetch(`/view/promotion-ledger${qs}`)
      if (!res.ok) throw new Error(`GET /view/promotion-ledger → ${res.status}`)
      const raw: unknown = await res.json()
      return responseSchema.parse(raw)
    },
  })

  return {
    entries: query.data?.entries ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
