import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchChatLayoutPreference,
  putChatLayoutPreference,
  type ChatLayout,
} from '@/shared/api'

const QUERY_KEY = ['preferences', 'chat-layout'] as const

export { fetchChatLayoutPreference, putChatLayoutPreference, type ChatLayout }

export function useChatLayoutPreference(): {
  layout: ChatLayout
  setLayout: (layout: ChatLayout) => void
  isPending: boolean
  isLoading: boolean
  error: Error | null
} {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchChatLayoutPreference,
    refetchInterval: 5_000,
  })
  const mutation = useMutation({
    mutationFn: putChatLayoutPreference,
    onSuccess: (value) => queryClient.setQueryData(QUERY_KEY, value),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  return {
    layout: query.data?.layout ?? 'focus',
    setLayout: (layout) => mutation.mutate(layout),
    isPending: mutation.isPending,
    isLoading: query.isPending,
    error: query.error ?? mutation.error,
  }
}
