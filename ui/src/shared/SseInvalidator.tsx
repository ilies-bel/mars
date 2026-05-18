import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { eventsUrl } from './api'
import { getOpenTaskId } from './openTaskId'
import { setSseConnected } from './sseStatus'

export const SseInvalidator = () => {
  const qc = useQueryClient()

  useEffect(() => {
    const es = new EventSource(eventsUrl())
    es.addEventListener('hello', () => setSseConnected(true))
    es.addEventListener('tasks', () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['inbox'] })
      // Refetch the open drawer's task alongside the Kanban so the status
      // chip and section data update in place. Switching the drawer to a
      // different id automatically retargets here because `getOpenTaskId`
      // reads the current store value at event time.
      const openId = getOpenTaskId()
      if (openId !== null) {
        void qc.invalidateQueries({ queryKey: ['task', openId] })
      }
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
