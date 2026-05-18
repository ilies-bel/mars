import { useQuery } from '@tanstack/react-query'
import { fetchInbox } from '@/shared/api'
import { useSseConnected } from '@/shared/sseStatus'
import type { InboxPayload } from '@/shared/types'

interface State {
  inbox: InboxPayload | null
  loading: boolean
  error: string | null
  connected: boolean
}

export const useInbox = (): State => {
  const connected = useSseConnected()
  const query = useQuery({
    queryKey: ['inbox'],
    queryFn: fetchInbox,
  })

  const inbox = query.data ?? null
  const loading = query.isLoading
  const error = query.error ? (query.error as Error).message : null

  return { inbox, loading, error, connected }
}
