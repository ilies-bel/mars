/**
 * Daemon-backed arc-rooted Alerts (ADR-0054).
 *
 * GET /api/alerts → Alert[]
 *
 * An Alert is a pure, never-persisted projection of the two operator-facing
 * failure families (a failed arc, a stale worktree). Unlike a Notice it has NO
 * ack — an Alert clears only when the underlying entity mutates (ADR-0048), so
 * this hook is read-only: it polls the daemon and hands back whatever the
 * derivation currently yields.
 *
 * The three text fields form a goal → reason → technical hierarchy:
 *   - `goal`      — what the arc was trying to achieve.
 *   - `reason`    — the warm, human-readable cause.
 *   - `technical` — the raw signal for an operator who wants the detail.
 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { z } from 'zod'

const BASE = import.meta.env.VITE_API_BASE ?? ''
const QUERY_KEY = ['alerts'] as const

/** One node in the arc's proposal → attempt → recovery lineage. */
const alertChainNodeSchema = z.object({
  kind: z.enum(['proposal', 'task']),
  id: z.string(),
  status: z.string().optional(),
  label: z.string(),
  attemptIndex: z.number().optional(),
})

// Require the identity + headline fields (arcId/goal/reason); keep the deeper
// technical detail optional so a shape drift on the daemon side degrades to a
// still-renderable Alert rather than a parse throw.
const alertSchema = z.object({
  arcId: z.string(),
  goal: z.string(),
  reason: z.string(),
  technical: z.string().optional(),
  kind: z.enum(['arc-failed', 'stale-worktree', 'verify-uncovered']).optional(),
  fingerprint: z.string().optional(),
  recipe: z.string().nullable().optional(),
  chain: z.array(alertChainNodeSchema).optional(),
})

// The daemon's GET /alerts returns a bare Alert array (no wrapper object).
const alertsResponseSchema = z.array(alertSchema)

export type AlertChainNode = z.infer<typeof alertChainNodeSchema>
export type Alert = z.infer<typeof alertSchema>

export async function fetchAlerts(): Promise<Alert[]> {
  const r = await fetch(`${BASE}/api/alerts`)
  if (!r.ok) throw new Error(`GET /api/alerts → ${r.status}`)
  return alertsResponseSchema.parse(await r.json())
}

export interface AlertsState {
  alerts: Alert[]
  error: Error | null
}

/**
 * Hook that syncs the arc-rooted Alert list with the daemon. Mount inside a
 * `QueryClientProvider`. Polls every ~15 s so an Alert that clears (via an
 * entity mutation) or a newly derived one surfaces without a manual refresh.
 */
export function useAlerts(): AlertsState {
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAlerts,
    refetchInterval: 15000,
  })

  return {
    alerts: query.data ?? [],
    error: (query.error as Error | null) ?? null,
  }
}

const startThreadResponseSchema = z.object({ threadId: z.string() })

/**
 * Pull an Alert into a chat thread (slice 4, ADR-0048). Human-triggered — the
 * operator clicked the Alert in the Bell or the hero "next action" shortcut. The
 * daemon dedups by arc (a re-click reuses the thread) and does NOT clear the
 * Alert from the Bell. Returns the thread id the caller navigates to.
 */
export async function startThreadFromAlert(arcId: string): Promise<{ threadId: string }> {
  const r = await fetch(`${BASE}/api/alerts/${encodeURIComponent(arcId)}/thread`, {
    method: 'POST',
  })
  if (!r.ok) throw new Error(`POST /api/alerts/${arcId}/thread → ${r.status}`)
  return startThreadResponseSchema.parse(await r.json())
}

/**
 * Mutation hook wrapping {@link startThreadFromAlert}. The caller navigates to
 * the returned thread on success; nothing else needs invalidating (picking an
 * Alert leaves the Bell list unchanged — an Alert clears only on arc resolution).
 */
export function useStartThreadFromAlert() {
  return useMutation({ mutationFn: startThreadFromAlert })
}
