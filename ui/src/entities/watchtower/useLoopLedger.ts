import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Server response schema — matches GET /view/loop-ledger
// Each entry represents one complete pass of the run→score→record→suggest→review
// loop for a given workflow kind. Stages may be absent when a run has not yet
// progressed that far.
// ---------------------------------------------------------------------------

const LoopLedgerEntrySchema = z.object({
  runId: z.string(),
  scoredAt: z.number().nullable(),
  score: z.number().nullable(),
  recordedAt: z.number().nullable(),
  suggestion: z.object({ version: z.string() }).nullable(),
  review: z.object({ decision: z.string() }).nullable(),
})

export type LoopLedgerEntry = z.infer<typeof LoopLedgerEntrySchema>

const responseSchema = z.object({
  entries: z.array(LoopLedgerEntrySchema),
})

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

interface LoopLedgerState {
  entries: LoopLedgerEntry[]
  isLoading: boolean
  error: Error | null
}

/**
 * Fetches the last `limit` per-run loop rows for the given workflow kind from
 * GET /view/loop-ledger?workflow=<kind>&limit=<n>.
 *
 * When `workflow` is null the query is skipped and an empty result is returned
 * immediately (no loading state) — this handles the initial render before the
 * workflow list has loaded.
 */
export const useLoopLedger = (workflow: string | null, limit = 50): LoopLedgerState => {
  const query = useQuery({
    queryKey: ['loop-ledger', workflow, limit],
    enabled: workflow !== null,
    queryFn: async () => {
      const res = await fetch(
        `/view/loop-ledger?workflow=${encodeURIComponent(workflow!)}&limit=${limit}`,
      )
      if (!res.ok) throw new Error(`GET /view/loop-ledger → ${res.status}`)
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
