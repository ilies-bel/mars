import { useQuery } from '@tanstack/react-query'
import { fetchTodo, type StaleWorktree } from '../lib/api'
import { useSseConnected } from '../lib/sseStatus'
import type { DraftFeature } from '../lib/types'

interface State {
  drafts: DraftFeature[]
  staleWorktrees: StaleWorktree[]
  error: string | null
  connected: boolean
}

export const useTodo = (): State => {
  const connected = useSseConnected()
  const query = useQuery({
    queryKey: ['todo'],
    queryFn: fetchTodo,
  })

  const drafts = query.data?.drafts ?? []
  const staleWorktrees = query.data?.staleWorktrees ?? []
  const error = query.error ? (query.error as Error).message : null

  return { drafts, staleWorktrees, error, connected }
}
