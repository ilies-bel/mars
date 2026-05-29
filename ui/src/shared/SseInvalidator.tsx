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

    // Coalesce rapid task-change events: many tasks may update in quick
    // succession (e.g. orchestrator dispatching a batch).  Rather than
    // firing N × 4 invalidations, debounce at 150 ms so the burst resolves
    // into a single set of refetches.
    let tasksDebounce: ReturnType<typeof setTimeout> | null = null
    es.addEventListener('tasks', () => {
      if (tasksDebounce !== null) clearTimeout(tasksDebounce)
      tasksDebounce = setTimeout(() => {
        tasksDebounce = null
        void qc.invalidateQueries({ queryKey: ['tasks'] })
        void qc.invalidateQueries({ queryKey: ['progress'] })
        void qc.invalidateQueries({ queryKey: ['inbox'] })
        void qc.invalidateQueries({ queryKey: ['action-queue'] })
        // Refetch the open drawer's task alongside Progress so the status
        // chip and section data update in place. Switching the drawer to a
        // different id automatically retargets here because `getOpenTaskId`
        // reads the current store value at event time.
        const openId = getOpenTaskId()
        if (openId !== null) {
          void qc.invalidateQueries({ queryKey: ['task', openId] })
        }
      }, 150)
    })

    // 'todo' events only touch the todo/inbox/action-queue surfaces — they do
    // not require a full progress refetch.
    let todoDebounce: ReturnType<typeof setTimeout> | null = null
    es.addEventListener('todo', () => {
      if (todoDebounce !== null) clearTimeout(todoDebounce)
      todoDebounce = setTimeout(() => {
        todoDebounce = null
        void qc.invalidateQueries({ queryKey: ['todo'] })
        void qc.invalidateQueries({ queryKey: ['inbox'] })
        void qc.invalidateQueries({ queryKey: ['action-queue'] })
      }, 150)
    })

    es.onerror = () => setSseConnected(false)
    return () => {
      if (tasksDebounce !== null) clearTimeout(tasksDebounce)
      if (todoDebounce !== null) clearTimeout(todoDebounce)
      es.close()
      setSseConnected(false)
    }
  }, [qc])

  return null
}
