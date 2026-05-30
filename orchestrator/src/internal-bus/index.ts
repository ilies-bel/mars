import { signalWakeHint } from '../outbox/wake-hint.js'
import type { InternalEventName, InternalEvents } from './events'

/**
 * Process-local wake-hint for cross-module publishers that need to signal
 * the outbox dispatcher without holding a reference to it.
 *
 * The internal bus is intentionally separate from the durable outbox in
 * `src/bus/`. It is NOT a delivery channel — calling `emit()` does not
 * fan out to per-event handlers. Instead it calls `signalWakeHint()` so
 * the dispatcher polls the database immediately after a same-process write,
 * bypassing the configured poll interval.
 *
 * Durable delivery happens via the outbox database, not via this bus.
 * The payload passed to `emit()` is accepted for type-safety documentation
 * (it proves the caller knows which outbox event was just written) but is
 * not stored or forwarded anywhere.
 *
 * There is no `on()` method: adding side-effecting subscribers here is
 * intentionally impossible. React to state changes via outbox subscribers
 * (`src/outbox/subscribers/`) instead.
 */

export interface InternalBus {
  /** Signal that an outbox event of type {@link T} was just written. */
  emit<T extends InternalEventName>(type: T, payload: InternalEvents[T]): void
}

class WakeHintBus implements InternalBus {
  emit<T extends InternalEventName>(_type: T, _payload: InternalEvents[T]): void {
    signalWakeHint()
  }
}

let singleton: InternalBus | null = null

export const internalBus = (): InternalBus => {
  if (!singleton) singleton = new WakeHintBus()
  return singleton
}

export type { InternalEventName, InternalEvents } from './events'
