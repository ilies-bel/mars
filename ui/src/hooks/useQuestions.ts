import { useEffect, useRef, useState } from 'react'
import { eventsUrl, fetchQuestions, fetchSuggestions } from '../lib/api'
import type { Question, TaskSuggestion } from '../lib/types'

interface State {
  questions: Question[]
  suggestions: TaskSuggestion[]
  error: string | null
  connected: boolean
}

export const useQuestions = (): State => {
  const [questions, setQuestions] = useState<Question[]>([])
  const [suggestions, setSuggestions] = useState<TaskSuggestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const inflight = useRef(false)

  const reload = async () => {
    if (inflight.current) return
    inflight.current = true
    try {
      const [qs, ss] = await Promise.all([fetchQuestions(), fetchSuggestions()])
      setQuestions(qs)
      setSuggestions(ss)
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
    es.addEventListener('questions', () => void reload())
    es.addEventListener('tasks', () => void reload())
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [])

  return { questions, suggestions, error, connected }
}
