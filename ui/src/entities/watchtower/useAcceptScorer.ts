import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { suggestedScorerSchema } from './useScorerSuggestions'

// ---------------------------------------------------------------------------
// Response schema — the accepted scorer row returned by the daemon.
// We reuse suggestedScorerSchema but override status to accept any string so
// the post-accept 'accepted' status parses without a separate schema.
// ---------------------------------------------------------------------------

const acceptScorerResponseSchema = z.object({
  scorer: suggestedScorerSchema.extend({ status: z.string() }),
})

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

interface AcceptScorerState {
  accept: (id: string) => void
  isPending: boolean
  error: Error | null
}

/**
 * Mutation hook that accepts a suggested scorer by id. Routes through the
 * daemon's acceptScorer() path — identical to `mars scorer accept <id>`.
 *
 * On success it invalidates:
 *  - ['scorer-suggestions'] so the suggestions panel refreshes
 *  - ['scorer-workflows'] so the trend charts appear once results start landing
 *
 * Accepting is a real operator decision: future instances of the scorer's
 * workflow will be graded. The hook provides accept() but does NOT auto-call
 * it — that call must come from an explicit UI gesture (e.g. a button click
 * inside a confirmation dialog).
 */
export const useAcceptScorer = (): AcceptScorerState => {
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch('/api/scorer-accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`POST /api/scorer-accept → ${res.status}: ${text}`)
      }
      const raw: unknown = await res.json()
      return acceptScorerResponseSchema.parse(raw)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scorer-suggestions'] })
      void queryClient.invalidateQueries({ queryKey: ['scorer-workflows'] })
    },
  })

  return {
    accept: mutation.mutate,
    isPending: mutation.isPending,
    error: mutation.error as Error | null,
  }
}
