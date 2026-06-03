/**
 * Small helpers shared across Command leaves. Pure/IO-light glue only — no
 * `console`, no `process.exit`. Anything user-visible flows through the
 * `deps.out`/`deps.err` sinks passed by the caller.
 */

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
    err(`spawned mars daemon (pid ${pid}, log ${logFile})`)
  }
