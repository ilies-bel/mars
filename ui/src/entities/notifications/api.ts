/**
 * Daemon-backed desktop notifications preference.
 *
 * GET  /api/preferences/notifications → { enabled: boolean }
 * PUT  /api/preferences/notifications  { enabled: boolean } → { enabled: boolean }
 *
 * The hook reads from the daemon on mount and writes back through it on
 * toggle so the preference survives daemon restarts and is visible to every
 * connected client.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

const BASE = import.meta.env.VITE_API_BASE ?? ''
const QUERY_KEY = ['preferences', 'notifications'] as const

const notificationsPreferenceSchema = z.object({ enabled: z.boolean() })

export async function fetchNotificationsPreference(): Promise<{ enabled: boolean }> {
  const r = await fetch(`${BASE}/api/preferences/notifications`)
  if (!r.ok) throw new Error(`GET /api/preferences/notifications → ${r.status}`)
  return notificationsPreferenceSchema.parse(await r.json())
}

export async function putNotificationsPreference(enabled: boolean): Promise<{ enabled: boolean }> {
  const r = await fetch(`${BASE}/api/preferences/notifications`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!r.ok) throw new Error(`PUT /api/preferences/notifications → ${r.status}`)
  return notificationsPreferenceSchema.parse(await r.json())
}

export interface NotificationsPreferenceState {
  /** Current enabled state — defaults to true (ON) before the daemon responds. */
  enabled: boolean
  /** PUT the new value to the daemon then re-fetches to confirm the persisted state. */
  setEnabled: (value: boolean) => void
  isPending: boolean
}

/**
 * Hook that syncs the desktop-notifications preference with the daemon.
 *
 * Mount inside a `QueryClientProvider`. The initial value is `true` (ON)
 * while the query is in flight, matching the daemon's own default on a fresh
 * installation.
 */
export function useNotificationsPreference(): NotificationsPreferenceState {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchNotificationsPreference,
  })

  const mutation = useMutation({
    mutationFn: putNotificationsPreference,
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  return {
    // Default to true so the switch appears ON while the query is in flight,
    // matching the daemon's out-of-box default.
    enabled: query.data?.enabled ?? true,
    setEnabled: (value: boolean) => mutation.mutate(value),
    isPending: mutation.isPending,
  }
}
