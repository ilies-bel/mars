/**
 * Derive a single project's daemon health on demand.
 *
 * Reads `.mars/http.port` under repoRoot and probes the daemon's HTTP server
 * with a short timeout. Returns:
 *   - 'down'     — port file absent/empty/malformed, or probe threw (ECONNREFUSED, abort)
 *   - 'live'     — 2xx within degradedMs (default 250ms)
 *   - 'degraded' — 2xx between degradedMs and timeoutMs (default 1500ms)
 *
 * Pure derivation — never cached. Every call re-reads the port file and
 * re-probes the daemon.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    if (Number.isNaN(port)) return 'down'
  } catch {
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
    if (!res.ok) return 'down'
    const elapsed = performance.now() - start
    return elapsed < degradedMs ? 'live' : 'degraded'
  } catch {
    return 'down'
  }
}
