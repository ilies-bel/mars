import { useSyncExternalStore } from 'react'

let connected = false
const listeners = new Set<() => void>()

export const setSseConnected = (value: boolean): void => {
  if (connected === value) return
  connected = value
  for (const l of listeners) l()
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const getSnapshot = (): boolean => connected

export const useSseConnected = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, () => false)
