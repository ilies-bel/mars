/**
 * Host file-descriptor headroom probe.
 *
 * Reports how many file descriptors the OS currently has open vs the
 * system-wide limit. Used by the init error formatter to distinguish a genuine
 * database failure from a host-level resource exhaustion that merely looks like
 * one (the symptom — "Query read timeout" — is misleading when no new process
 * can open a socket because the host fd table is full).
 *
 * Supported platforms:
 *   - macOS / BSD  → sysctl kern.num_files / kern.maxfiles
 *   - Linux        → /proc/sys/fs/file-nr
 *   - Other        → not supported; probe returns null
 *
 * The probe NEVER throws. Any failure (unsupported platform, permission error,
 * parse error, child-process timeout) silently returns null so the caller's
 * error-formatting path is unaffected.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A snapshot of the host's file-descriptor usage. */
export interface FdHeadroom {
  /** Number of file descriptors currently open system-wide. */
  used: number
  /** System-wide file-descriptor ceiling. */
  limit: number
  /** Fractional usage: used / limit (0 … 1). */
  pct: number
}

/**
 * Injectable OS-call deps.
 *
 * The real implementations invoke `sysctl` (macOS/BSD) or read
 * `/proc/sys/fs/file-nr` (Linux). Tests inject synchronous stubs that return
 * or throw predetermined values without shelling out.
 */
export interface FdHeadroomDeps {
  /** Value of `process.platform` on the target machine. */
  platform: string
  /**
   * Read a single numeric sysctl key (macOS/BSD only).
   * Must throw on any error.
   */
  readSysctlNum: (key: string) => number
  /**
   * Read `/proc/sys/fs/file-nr` as a UTF-8 string (Linux only).
   * Must throw on any error.
   */
  readFileNr: () => string
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

const realFdHeadroomDeps: FdHeadroomDeps = {
  platform: process.platform,

  readSysctlNum: (key: string): number => {
    const out = execFileSync('sysctl', ['-n', key], {
      encoding: 'utf8',
      timeout: 2000,
    })
    const n = parseInt(out.trim(), 10)
    if (Number.isNaN(n)) throw new Error(`sysctl ${key} returned non-numeric: ${out.trim()}`)
    return n
  },

  readFileNr: (): string => readFileSync('/proc/sys/fs/file-nr', 'utf8'),
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probe the host's file-descriptor headroom.
 *
 * Returns a {@link FdHeadroom} snapshot on macOS/BSD and Linux.
 * Returns `null` on unsupported platforms or when the probe fails for any
 * reason — the caller's error path must not depend on this succeeding.
 */
export const probeFdHeadroom = (deps: FdHeadroomDeps = realFdHeadroomDeps): FdHeadroom | null => {
  try {
    if (deps.platform === 'darwin' || deps.platform === 'freebsd') {
      const used = deps.readSysctlNum('kern.num_files')
      const limit = deps.readSysctlNum('kern.maxfiles')
      if (limit === 0) return null
      return { used, limit, pct: used / limit }
    }

    if (deps.platform === 'linux') {
      const content = deps.readFileNr()
      // /proc/sys/fs/file-nr: <allocated> <freed-but-not-released> <system-limit>
      const parts = content.trim().split(/\s+/)
      const used = parseInt(parts[0] ?? '', 10)
      const limit = parseInt(parts[2] ?? '', 10)
      if (Number.isNaN(used) || Number.isNaN(limit) || limit === 0) return null
      return { used, limit, pct: used / limit }
    }

    // Unsupported platform — signal by returning null.
    return null
  } catch {
    // Any probe failure is non-fatal; fall through to null.
    return null
  }
}

// ---------------------------------------------------------------------------
// Error enrichment
// ---------------------------------------------------------------------------

/**
 * Fraction of the system fd ceiling at which we diagnose exhaustion.
 *
 * Calibrated so that a system where one process holds >240k of ~256k open
 * file descriptors (leaving the remainder starved) is flagged even though
 * the raw system-wide percentage is under 60%.
 */
const FD_EXHAUSTION_THRESHOLD = 0.5

/**
 * Format the operator-readable fd-exhaustion message.
 * The original DB error is kept as subordinate detail (DEC-18 pattern)
 * so it is not lost — it is still the right string for a genuine DB fault.
 */
const formatFdExhaustionMessage = (fd: FdHeadroom, rawDbError: string): string => {
  const pctDisplay = Math.round(fd.pct * 100)
  return (
    `Mars could not start its database, but the database is not the problem: ` +
    `this machine has almost no file descriptors left ` +
    `(${fd.used} of ${fd.limit} in use, ${pctDisplay}%). ` +
    `Find what is holding them before retrying — on macOS, ` +
    `\`lsof -n -P | awk '{print $1}' | sort | uniq -c | sort -rn | head\` ` +
    `names the biggest holders.\n\n` +
    `Detail: ${rawDbError}`
  )
}

/**
 * Enrich an init-phase DB error with a host fd-exhaustion diagnosis when
 * appropriate.
 *
 * Accepts an optional `probeOverride` so unit tests can inject a stubbed probe
 * without shelling out to the real OS.
 *
 * Behaviour:
 * - probe reports usage ≥ {@link FD_EXHAUSTION_THRESHOLD}: returns the
 *   fd-exhaustion message with the original DB error kept as detail.
 * - probe reports healthy headroom: returns `rawDbError` unchanged.
 * - probe (or override) throws: returns `rawDbError` unchanged; never re-throws.
 * - probe returns null (unsupported platform / parse failure): returns
 *   `rawDbError` unchanged.
 *
 * Never throws.
 */
export const enrichInitDbError = (
  rawDbError: string,
  probeOverride?: () => FdHeadroom | null,
): string => {
  try {
    const headroom = probeOverride ? probeOverride() : probeFdHeadroom()
    if (headroom !== null && headroom.pct >= FD_EXHAUSTION_THRESHOLD) {
      return formatFdExhaustionMessage(headroom, rawDbError)
    }
  } catch {
    // probe threw — fall through to the original message
  }
  return rawDbError
}
