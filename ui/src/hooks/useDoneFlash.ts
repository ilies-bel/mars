import { useEffect, useRef, useState } from 'react'
import type { ProgressTask } from '@/shared/schemas'

/** Duration each "done" task stays in the flash window before being removed. */
const FLASH_DURATION_MS = 3000

export interface DoneFlashState {
  /** Tasks that have recently transitioned to done and are in their flash window. */
  flashingTasks: ProgressTask[]
  /** Set of IDs in the flash window — for O(1) membership checks. */
  flashingTaskIds: Set<string>
}

/**
 * Detects when tasks disappear from the active list (they have transitioned to
 * done) and keeps them visible for FLASH_DURATION_MS so the UI can play a
 * "done" confirmation animation before removing them from the canvas.
 *
 * Usage:
 *   const { flashingTasks, flashingTaskIds } = useDoneFlash(tasks)
 *
 * Pass `flashingTasks` to views so they keep the "ghost" card visible.
 * Pass `flashingTaskIds` to views so they apply the flash animation class.
 */
export const useDoneFlash = (tasks: ProgressTask[] | null): DoneFlashState => {
  const [flashingMap, setFlashingMap] = useState<Map<string, ProgressTask>>(new Map())
  // Tracks the full task data from the most recent render for disappearance detection.
  const prevTaskMapRef = useRef<Map<string, ProgressTask>>(new Map())
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    if (tasks === null) return

    const prevMap = prevTaskMapRef.current
    const currentMap = new Map<string, ProgressTask>()
    for (const t of tasks) currentMap.set(t.id, t)

    // Tasks that were active on the previous poll but are gone now have transitioned
    // to done (failed/dropped tasks stay in the Failed cluster and keep appearing).
    const newlyGone: ProgressTask[] = []
    for (const [id, task] of prevMap) {
      if (!currentMap.has(id)) newlyGone.push(task)
    }

    prevTaskMapRef.current = currentMap

    if (newlyGone.length === 0) return

    setFlashingMap((prev) => {
      const next = new Map(prev)
      for (const t of newlyGone) next.set(t.id, t)
      return next
    })

    for (const t of newlyGone) {
      // Reset the timer if the task somehow reappears and disappears again.
      const existing = timeoutsRef.current.get(t.id)
      if (existing !== undefined) clearTimeout(existing)

      timeoutsRef.current.set(
        t.id,
        setTimeout(() => {
          setFlashingMap((prev) => {
            if (!prev.has(t.id)) return prev
            const next = new Map(prev)
            next.delete(t.id)
            return next
          })
          timeoutsRef.current.delete(t.id)
        }, FLASH_DURATION_MS),
      )
    }
  }, [tasks])

  // Clean up pending timeouts on unmount so we don't setState after unmount.
  useEffect(() => {
    return () => {
      for (const id of timeoutsRef.current.values()) clearTimeout(id)
    }
  }, [])

  const flashingTasks = [...flashingMap.values()]
  const flashingTaskIds = new Set(flashingMap.keys())

  return { flashingTasks, flashingTaskIds }
}
