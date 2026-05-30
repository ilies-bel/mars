/**
 * Shared helpers that decide what a UI fallback surface should show based on
 * the Vite build mode.
 *
 * - In dev (`import.meta.env.DEV === true`): expose the raw error text so the
 *   operator running the app locally can diagnose the problem quickly.
 * - In prod: suppress diagnostics; show only a calm one-line message.
 */

/**
 * Returns the copy for a fallback surface.
 *
 * @param surfaceLabel - A human-readable name for the section that failed to
 *   load (e.g. 'failure-reason catalog', 'trace events'). Used in the headline.
 * @param error - The raw error value to expose in dev mode.
 */
export function getFallbackCopy(
  surfaceLabel: string,
  error: unknown,
): { headline: string; detail: string | null } {
  return {
    headline: `Couldn't load the ${surfaceLabel}.`,
    detail: import.meta.env.DEV ? String(error) : null,
  }
}

/**
 * Logs the error to the browser console in dev mode only.
 * No-ops silently in production so that end-users never see diagnostics.
 */
export function logFallbackError(error: unknown): void {
  if (import.meta.env.DEV) {
    console.error(error)
  }
}
