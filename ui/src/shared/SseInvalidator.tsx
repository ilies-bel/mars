import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { eventsUrl } from './api'
import { setSseConnected } from './sseStatus'

export const SseInvalidator = () => {
  const qc = useQueryClient()

  useEffect(() => {
    const es = new EventSource(eventsUrl())
    es.addEventListener('hello', () => setSseConnected(true))
    es.addEventListener('tasks', () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['inbox'] })
    })
    es.addEventListener('todo', () => {
      void qc.invalidateQueries({ queryKey: ['todo'] })
      void qc.invalidateQueries({ queryKey: ['inbox'] })
    })
    es.onerror = () => setSseConnected(false)
    return () => {
      es.close()
      setSseConnected(false)
    }
  }, [qc])

  return null
}
