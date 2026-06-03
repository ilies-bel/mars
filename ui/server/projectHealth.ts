/**
 * Derive a single project's daemon health on demand.
 *
 * Reads `.mars/http.port` under repoRoot and probes the daemon's HTTP server
 * with a short timeout. Returns:
 *   - 'down'     — port file absent/empty/malformed, or probe threw (ECONNREFUSED, abort)
 *   - 'live'     — 2xx within degradedMs (default 250ms), or fewer than
 *                  DEGRADED_STREAK_THRESHOLD consecutive slow probes
 *   - 'degraded' — 2xx but slow for DEGRADED_STREAK_THRESHOLD consecutive probes
 *
 * Hysteresis: a single slow-but-reachable probe does not immediately flip the
 * badge to 'degraded'. The daemon must be slow on DEGRADED_STREAK_THRESHOLD
 * consecutive probes before 'degraded' is reported. One fast probe resets the
 * streak back to 'live'. 'down' is always reported immediately and also resets
 * the streak.
 *
 * The streak state is module-local and best-effort (resets on server restart).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Number of consecutive slow-but-reachable probes required before reporting 'degraded'.
const DEGRADED_STREAK_THRESHOLD = 3

// Per-repoRoot count of consecutive slow probes. Absent key == 0.
const slowStreaks = new Map<string, number>()

export const probeDaemonHealth = async (
  repoRoot: string,
  opts?: { timeoutMs?: number; degradedMs?: number },
): Promise<'live' | 'degraded' | 'down'> => {
  const timeoutMs = opts?.timeoutMs ?? 1500
  const degradedMs = opts?.degradedMs ?? 250

  let port: number
  try {
    const raw = readFileSync(join(repoRoot, '.mars', 'http.port'), 'utf8').trim()
    port = parseInt(raw, 10)
    if (Number.isNaN(port)) {
      slowStreaks.delete(repoRoot)
      return 'down'
    }
  } catch {
    slowStreaks.delete(repoRoot)
    return 'down'
  }

  const start = performance.now()
  try {
    let res = await globalThis.fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      res = await globalThis.fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    if (!res.ok) {
      slowStreaks.delete(repoRoot)
      return 'down'
    }
    const elapsed = performance.now() - start
    if (elapsed < degradedMs) {
      slowStreaks.delete(repoRoot)
      return 'live'
    }
    // Slow but reachable — increment streak and apply hysteresis threshold.
    const streak = (slowStreaks.get(repoRoot) ?? 0) + 1
    slowStreaks.set(repoRoot, streak)
    return streak >= DEGRADED_STREAK_THRESHOLD ? 'degraded' : 'live'
  } catch {
    slowStreaks.delete(repoRoot)
    return 'down'
  }
}
