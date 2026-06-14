/**
 * The UI fallback surface — the single seam that turns any error into a fully
 * resolved fallback (headline, remedy, dev detail, severity) and owns the
 * dev/prod copy split and the dev-only logging side effect.
 *
 * A "UI fallback surface" (CONTEXT.md) is a UI region that renders in place of
 * real data when a fetch fails (error) or returns nothing (empty). This module
 * owns the *error* half: it is the one place that reads `ApiError.kind` — the
 * remedy discriminant — and decides what the operator sees.
 *
 * Build-mode rule:
 * - In dev (`import.meta.env.DEV === true`): expose the raw error text and the
 *   remedy hint so the operator running the app locally can diagnose quickly.
 * - In prod: suppress diagnostics; show only the calm headline + remedy line.
 */

import { ApiError, type ApiErrorKind } from './api'

/** How loud a fallback should render. Drives colour at the render seam. */
export type FallbackSeverity = 'error' | 'warning'

/**
 * A fully resolved fallback — everything the render seam needs, with no further
 * branching on `import.meta.env.DEV` or on the error's kind. Produced by
 * {@link resolveFallback}; consumed by `<FallbackSurface>`.
 */
export interface Fallback {
  /** The calm one-line headline, always shown. */
  headline: string
  /** The remedy line (how to fix), always shown. Null when there is no known remedy. */
  remedy: string | null
  /**
   * Raw diagnostic detail — the stringified error. Non-null only in dev mode;
   * always null in prod so operators never see diagnostics they can't act on.
   */
  detail: string | null
  /** Render loudness. `stale-daemon` is a warning (recoverable); the rest are errors. */
  severity: FallbackSeverity
}

/** Per-kind copy: the headline + remedy + loudness for each `ApiError.kind`. */
const KIND_COPY: Record<
  ApiErrorKind,
  { headline: string; remedy: string; severity: FallbackSeverity }
> = {
  unreachable: {
    headline: "Can't reach the dashboard server right now.",
    remedy:
      'Start it with `npm run dev:server` in the `ui/` directory, or `npm run dev:all` to run the UI and API server together.',
    severity: 'error',
  },
  'stale-daemon': {
    headline: 'The daemon is unreachable (stale port).',
    remedy: 'Restart it with `mars daemon restart`.',
    severity: 'warning',
  },
  other: {
    headline: 'The dashboard server returned an error.',
    remedy: 'Check the daemon logs; retry once the underlying issue clears.',
    severity: 'error',
  },
}

/** Remedy shown for a non-`ApiError` throw (a render bug, a schema mismatch, …). */
const UNKNOWN_REMEDY = 'Reload the page; if it persists, check the daemon logs.'

/**
 * Resolve any thrown value into a {@link Fallback}. This is the ONE place that
 * interprets `ApiError.kind` and the ONE place that applies the dev/prod split.
 *
 * @param error - The thrown value (an `ApiError`, a plain `Error`, or anything).
 * @param surfaceLabel - A human-readable name for the section that failed to
 *   load (e.g. 'trace events', 'origin tasks'). Woven into the headline when
 *   the error is not a classified `ApiError`.
 */
export function resolveFallback(error: unknown, surfaceLabel: string): Fallback {
  const dev = import.meta.env.DEV
  const detail = dev ? stringifyError(error) : null

  if (error instanceof ApiError) {
    const copy = KIND_COPY[error.kind]
    return { headline: copy.headline, remedy: copy.remedy, detail, severity: copy.severity }
  }

  return {
    headline: `Couldn't load the ${surfaceLabel}.`,
    remedy: dev ? UNKNOWN_REMEDY : null,
    detail,
    severity: 'error',
  }
}

/** Stringify a thrown value for the dev `detail` line. */
function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Logs the error to the browser console in dev mode only. No-ops silently in
 * production so end-users never see diagnostics. Owned here so the render seam
 * and the error boundary share one logging side effect.
 */
export function logFallbackError(error: unknown): void {
  if (import.meta.env.DEV) {
    console.error(error)
  }
}
