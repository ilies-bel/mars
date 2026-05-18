/**
 * Tiny external store holding the id of the task whose detail drawer is
 * currently mounted. Drawers register themselves on mount and clear on
 * unmount; the `SseInvalidator` reads the current value so it can invalidate
 * the open task's query alongside the list when SSE fires.
 *
 * The store is intentionally global: only one detail drawer can be open at a
 * time, and decoupling the producer (drawer) from the consumer (invalidator)
 * keeps the SSE wiring independent of where the drawer sits in the tree.
 */

let openTaskId: string | null = null
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const l of listeners) l()
}

export const setOpenTaskId = (value: string | null): void => {
  if (openTaskId === value) return
  openTaskId = value
  emit()
}

export const getOpenTaskId = (): string | null => openTaskId

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// Test-only hook so suites can subscribe without a React renderer.
export const subscribeOpenTaskId = subscribe
