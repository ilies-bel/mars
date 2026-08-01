/**
 * Daemon-backed Notice bell messages (ADR-0079).
 *
 * GET  /api/notices            → { notices: Notice[] }
 * POST /api/notices/:id/ack    → { acknowledged: boolean }
 *
 * A Notice is entity-less, so — unlike an Alert — it clears only when the
 * operator acknowledges it. The UI is read-only with respect to the DB; the ack
 * op is driven through the daemon (the sole writer, ADR-0035).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

const BASE = import.meta.env.VITE_API_BASE ?? ''
const QUERY_KEY = ['notices'] as const

const preloadedResponseSchema = z.object({
  op: z.string(),
  label: z.string(),
  entityId: z.string(),
})

const noticeSchema = z.object({
  id: z.string(),
  body: z.string(),
  source: z.string().nullable(),
  createdAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  preloadedResponses: z.array(preloadedResponseSchema).optional().default([]),
})

const noticesResponseSchema = z.object({ notices: z.array(noticeSchema) })
const ackResponseSchema = z.object({ acknowledged: z.boolean() })

export type Notice = z.infer<typeof noticeSchema>
export type PreloadedResponse = z.infer<typeof preloadedResponseSchema>

export async function fetchNotices(): Promise<Notice[]> {
  const r = await fetch(`${BASE}/api/notices`)
  if (!r.ok) throw new Error(`GET /api/notices → ${r.status}`)
  return noticesResponseSchema.parse(await r.json()).notices
}

export async function ackNotice(id: string): Promise<boolean> {
  const r = await fetch(`${BASE}/api/notices/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
  })
  if (!r.ok) throw new Error(`POST /api/notices/${id}/ack → ${r.status}`)
  return ackResponseSchema.parse(await r.json()).acknowledged
}

export interface NoticesState {
  notices: Notice[]
  error: Error | null
  /** POST the ack to the daemon then invalidates the query so the row drops. */
  ack: (id: string) => void
  isPending: boolean
}

/**
 * Hook that syncs the open Notice list with the daemon. Mount inside a
 * `QueryClientProvider`. Polls every ~15 s so an ack from another client (or a
 * newly raised notice) surfaces without a manual refresh.
 */
export function useNotices(): NoticesState {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchNotices,
    refetchInterval: 15000,
  })

  const mutation = useMutation({
    mutationFn: ackNotice,
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  return {
    notices: query.data ?? [],
    error: (query.error as Error | null) ?? null,
    ack: (id: string) => mutation.mutate(id),
    isPending: mutation.isPending,
  }
}
