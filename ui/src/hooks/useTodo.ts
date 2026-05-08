import { useEffect, useRef, useState } from 'react'
import { eventsUrl, fetchTodo } from '../lib/api'
import type { DraftFeature, TaskSuggestion } from '../lib/types'

interface State {
  drafts: DraftFeature[]
  suggestions: TaskSuggestion[]
  error: string | null
  connected: boolean
}

export const useTodo = (): State => {
  const [drafts, setDrafts] = useState<DraftFeature[]>([])
  const [suggestions, setSuggestions] = useState<TaskSuggestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const inflight = useRef(false)

  const reload = async (): Promise<void> => {
    if (inflight.current) return
    inflight.current = true
    try {
      const payload = await fetchTodo()
      setDrafts(payload.drafts)
      setSuggestions(payload.suggestions)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      inflight.current = false
    }
  }

  useEffect(() => {
    void reload()
    const es = new EventSource(eventsUrl())
    es.addEventListener('hello', () => setConnected(true))
    es.addEventListener('todo', () => void reload())
    es.addEventListener('tasks', () => void reload())
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [])

  return { drafts, suggestions, error, connected }
}
