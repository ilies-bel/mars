import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { appendProject, fetchJson } from '@/shared/api'
import { useFocusedProjectId } from '@/shared/useFocusedProject'

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
 * GET /api/loop-ledger?workflow=<kind>&limit=<n>.
 *
 * When `workflow` is null the query is skipped and an empty result is returned
 * immediately (no loading state) — this handles the initial render before the
 * workflow list has loaded.
 */
export const useLoopLedger = (workflow: string | null, limit = 50): LoopLedgerState => {
  const projectId = useFocusedProjectId()
  const query = useQuery({
    queryKey: ['loop-ledger', projectId, workflow, limit],
    enabled: workflow !== null,
    queryFn: () => fetchJson(
      appendProject(
        `/api/loop-ledger?workflow=${encodeURIComponent(workflow!)}&limit=${limit}`,
        projectId ?? undefined,
      ),
      responseSchema,
    ),
  })

  return {
    entries: query.data?.entries ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
