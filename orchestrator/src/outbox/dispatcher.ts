import type { Client } from '@libsql/client';
import type { BusEvent } from '../bus/events.js';
import { fetchPending, advanceCursor } from '../bus/subscribers.js';
import { apiCircuitBreaker } from '../core/lib/api-circuit-breaker.js';

/**
 * A named consumer of the Outbox `events` table paired with a delivery
 * handler. The `name` must match a row registered via
 * {@link registerSubscriber} before the dispatcher starts.
 */
export interface Subscriber {
  /** Must match the registered subscriber name in the `subscribers` table. */
  name: string;
  /**
   * Called once per event in delivery order. The cursor advances only if
   * this resolves — a rejection leaves the cursor in place so the event
   * is re-delivered on the next poll or wake-hint cycle.
   */
  handler: (event: BusEvent) => Promise<void>;
  /**
   * When true, dispatch is paused while the API circuit breaker is open.
   * Set this on subscribers that route code-phase (run-claude-code) work so
   * tasks remain queued rather than burning their retry budget against an
   * unreachable API.
   *
   * Non-code subscribers (transcript-append, blocker-resolution, etc.) must
   * NOT set this flag — they are unaffected by API connectivity.
   */
  gatedByApiBreaker?: boolean;
}

/**
 * A running dispatcher handle. Each Subscriber has its own independent
 * delivery loop — a slow or failing Subscriber does not block others.
 */
export interface Dispatcher {
  /**
   * Signal that a new event was published in this process. Immediately
   * unblocks all Subscriber loops that are sleeping between polls,
   * bypassing the configured poll interval.
   */
  notify(): void;
  /**
   * Stop all delivery loops. Returns a promise that resolves once every
   * loop has exited cleanly.
   */
  stop(): Promise<void>;
}

/**
 * Start a dispatcher that drives each Subscriber forward by pulling events
 * strictly after its cursor, invoking the Subscriber's handler, and
 * advancing the cursor only on successful handler return.
 *
 * Same-process publishers should call {@link Dispatcher.notify} immediately
 * after writing to the Outbox so delivery happens without waiting for the
 * next poll. If no hint arrives the dispatcher falls back to polling every
 * `pollMs` milliseconds (default 5 000 ms) so cross-process writes are
 * still picked up.
 *
 * Subscribers advance independently — a slow or failing Subscriber does
 * not delay another.
 */
export function startDispatcher(
  client: Client,
  subscribers: Subscriber[],
  opts?: { pollMs?: number },
): Dispatcher {
  const pollMs = opts?.pollMs ?? 5_000;
  let stopped = false;

  // Wake-hint mechanism. All subscriber loops race against this promise;
  // notify() resolves it and installs a fresh pending promise for the next
  // cycle so subsequent waits do not return immediately.
  let resolveWake!: () => void;
  let wakePromise: Promise<void> = new Promise(r => {
    resolveWake = r;
  });

  function notify(): void {
    const resolve = resolveWake;
    // Replace BEFORE resolving: a subscriber that wakes up and immediately
    // loops back captures the new (still-pending) promise, not the one that
    // is already resolved.
    wakePromise = new Promise(r => {
      resolveWake = r;
    });
    resolve();
  }

  async function runSubscriber(sub: Subscriber): Promise<void> {
    while (!stopped) {
      // Capture the wake promise BEFORE the async fetch. If notify() fires
      // during the fetch the captured reference already points to the
      // now-resolved promise, so the subsequent Promise.race returns
      // immediately rather than blocking until the next hint.
      const currentWake = wakePromise;

      let events: BusEvent[];
      try {
        events = await fetchPending(client, sub.name);
      } catch {
        // Transient DB error — back off and retry.
        await Promise.race([
          currentWake,
          new Promise<void>(r => setTimeout(r, pollMs)),
        ]);
        continue;
      }

      if (events.length === 0) {
        await Promise.race([
          currentWake,
          new Promise<void>(r => setTimeout(r, pollMs)),
        ]);
        continue;
      }

      // API circuit-breaker gate: when the breaker is open, hold off
      // dispatching code-phase events until connectivity is restored.
      // The cursor stays unchanged so events are replayed on the next tick.
      if (sub.gatedByApiBreaker && apiCircuitBreaker.isOpen()) {
        const { reason } = apiCircuitBreaker.state();
        console.error(`[dispatcher] code dispatch paused: ${reason ?? 'circuit open'}`);
        await Promise.race([
          currentWake,
          new Promise<void>(r => setTimeout(r, pollMs)),
        ]);
        continue;
      }

      for (const event of events) {
        if (stopped) break;
        try {
          await sub.handler(event);
          await advanceCursor(client, sub.name, event.id);
        } catch {
          // Handler failed — leave cursor unchanged so the event is
          // re-delivered on the next cycle.
          await Promise.race([
            wakePromise,
            new Promise<void>(r => setTimeout(r, pollMs)),
          ]);
          break;
        }
      }
    }
  }

  const loops = subscribers.map(sub => runSubscriber(sub));

  return {
    notify,
    stop(): Promise<void> {
      stopped = true;
      notify(); // Unblock any loops sleeping in their wait phase.
      return Promise.all(loops).then(() => undefined);
    },
  };
}
