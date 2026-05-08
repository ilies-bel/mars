import { useEffect, useRef, useState } from 'react'
import { eventsUrl, fetchTasks } from '../lib/api'
import { groupTasks } from '../lib/group'
import type { Snapshot } from '../lib/types'

interface State {
  snapshot: Snapshot | null
  error: string | null
  connected: boolean
}

const empty: Snapshot = {
  columns: {
    backlog: [],
    planned: [],
    in_progress: [],
    blocked: [],
    done: [],
    dropped: [],
  },
  counts: { inProgress: 0, todo: 0, done: 0 },
}

export const useTasks = (): State => {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const inflight = useRef(false)

  const reload = async () => {
    if (inflight.current) return
    inflight.current = true
    try {
      const tasks = await fetchTasks()
      setSnapshot(groupTasks(tasks))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
      setSnapshot((s) => s ?? empty)
    } finally {
      inflight.current = false
    }
  }

  useEffect(() => {
    void reload()
    const es = new EventSource(eventsUrl())
    es.addEventListener('hello', () => setConnected(true))
    es.addEventListener('tasks', () => void reload())
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [])

  return { snapshot, error, connected }
}
