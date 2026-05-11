import { EventEmitter } from 'node:events'

/**
 * Process-local event bus for cross-module signals emitted from library
 * code (queue mutations, blocker resolution) that the daemon — or any
 * other in-process subscriber — wants to react to without library code
 * holding a reference to the daemon's own EventEmitter.
 *
 * This is intentionally separate from the outbox/wire bus in
 * `src/bus/` (which is durable and consumed by external processes).
 * The internal bus is fire-and-forget and only valid for the lifetime
 * of the current Node process.
 */

export interface InternalEvents {
  'task.blocked': {
    taskId: string
    fixTaskId: string | null
    failureSignature: string
    failingStep: string
  }
  'task.unblocked': {
    taskId: string
    blockerTaskId: string
  }
}

export type InternalEventName = keyof InternalEvents

class TypedEmitter {
  private readonly inner = new EventEmitter()

  constructor() {
    this.inner.setMaxListeners(50)
  }

  emit<T extends InternalEventName>(type: T, payload: InternalEvents[T]): void {
    this.inner.emit(type, payload)
  }

  on<T extends InternalEventName>(
    type: T,
    handler: (payload: InternalEvents[T]) => void,
  ): () => void {
    this.inner.on(type, handler as (p: unknown) => void)
    return () => {
      this.inner.off(type, handler as (p: unknown) => void)
    }
  }
}

let singleton: TypedEmitter | null = null

export const internalBus = (): TypedEmitter => {
  if (!singleton) singleton = new TypedEmitter()
  return singleton
}
