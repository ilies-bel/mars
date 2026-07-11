/**
 * Small helpers shared across Command leaves. Pure/IO-light glue only — no
 * `console`, no `process.exit`. Anything user-visible flows through the
 * `deps.out`/`deps.err` sinks passed by the caller.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Normalise an unknown thrown value to its message string. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Match the daemon-not-running family of errors. */
export const isDaemonDownError = (msg: string): boolean =>
  /not running|auto-spawn disabled/i.test(msg)

/**
 * The standard daemon spawn-notice handler used by mutation commands: prints
 * a one-line started-daemon notice to stdout via `out`.
 */
export const spawnNoticeOut =
  (out: (s: string) => void) =>
  (pid: number, logFile: string): void => {
    out(`[mars] started daemon (pid ${pid}, log: ${logFile})`)
  }

/**
 * Variant that prints the spawn notice to stderr (glossary/adr use this).
 */
export const spawnNoticeErr =
  (err: (s: string) => void) =>
  (pid: number, logFile: string): void => {
    err(`[mars] started daemon (pid ${pid}, log: ${logFile})`)
  }

/**
 * Read the daemon's HTTP port from the port file published by `listen(0)`.
 * Returns null when the file is absent or contains a non-integer value.
 */
export const readDaemonPort = async (stateDir: string): Promise<number | null> => {
  try {
    const raw = (await readFile(join(stateDir, 'http.port'), 'utf8')).trim()
    const port = Number(raw)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}
