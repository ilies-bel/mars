/**
 * Periodic endpoint probe that closes the API circuit breaker when the
 * Anthropic API becomes reachable again.
 *
 * While the breaker is open the probe runs on a configurable interval
 * (default 30 s). On a successful probe it calls `apiCircuitBreaker.close()`
 * so the dispatcher resumes on the next tick. While the breaker is closed
 * the probe skips the tick — there is nothing to heal.
 *
 * The real probe sends a lightweight HEAD request to the Anthropic API host;
 * any HTTP response (including 4xx/5xx) counts as "reachable" — we only need
 * TCP/TLS connectivity, not a valid auth session.
 *
 * Usage (daemon startup):
 *   const stopProbe = startApiEndpointProbe()
 *   // on shutdown:
 *   stopProbe()
 */

import { apiCircuitBreaker } from './api-circuit-breaker'

const defaultProbe = async (): Promise<boolean> => {
  try {
    const res = await fetch('https://api.anthropic.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    })
    return res.status > 0
  } catch {
    return false
  }
}

/**
 * Start the endpoint probe loop. Returns a stop function that cancels the
 * interval. The interval timer is `.unref()`'d so it never prevents a clean
 * process shutdown.
 */
export const startApiEndpointProbe = ({
  probe = defaultProbe,
  intervalMs = 30_000,
}: {
  probe?: () => Promise<boolean>
  intervalMs?: number
} = {}): (() => void) => {
  let running = false

  const timer = setInterval(() => {
    if (!apiCircuitBreaker.isOpen()) return
    if (running) return

    running = true
    void probe()
      .then((ok) => {
        if (ok) apiCircuitBreaker.close()
      })
      .catch(() => {
        // probe threw — treat as unreachable; breaker stays open
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)

  // Never prevent a clean process shutdown.
  timer.unref()

  return (): void => clearInterval(timer)
}
