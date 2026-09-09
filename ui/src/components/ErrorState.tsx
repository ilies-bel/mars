import { AlertTriangle } from 'lucide-react'
/**
 * ErrorState — unified page-level error render seam with an optional Retry
 * button.
 *
 * Compared to FallbackSurface:
 *   1. `onRetry` renders a Retry button that calls back into the data layer.
 *   2. For ApiErrors with a 4xx HTTP status the endpoint's own error message
 *      ("GET /api/proposals → 404") is shown as the headline instead of the
 *      generic "stale port / restart the daemon" remedy copy. This matches the
 *      requirement that 4xx responses surface what actually went wrong rather
 *      than implying a daemon restart will fix it.
 *   3. An icon prefix (⚠) is always prepended to the headline for visual
 *      consistency across pane and inline variants.
 *
 * Usage:
 *   <ErrorState error={err} of="proposals" onRetry={() => refetch()} />
 */

import { useEffect } from 'react'
import { ApiError } from '@/shared/api'
import { resolveFallback, logFallbackError } from '@/shared/uiFallback'

export interface ErrorStateProps {
  /**
   * The thrown value — an ApiError, a plain Error, or any unknown throw.
   * ApiErrors with a 4xx status receive special-cased headline copy.
   */
  error: unknown
  /**
   * Human-readable name of the section that failed (e.g. 'proposals').
   * Used by resolveFallback() when the error is not a classified ApiError.
   */
  of: string
  /**
   * Called when the operator clicks Retry. Omit to hide the Retry button.
   */
  onRetry?: () => void
  /**
   * `pane` — centred full-region box (default).
   * `inline` — compact one-line block suitable for sub-sections.
   */
  variant?: 'pane' | 'inline'
}

export const ErrorState = ({
  error,
  of,
  onRetry,
  variant = 'pane',
}: ErrorStateProps) => {
  useEffect(() => {
    logFallbackError(error)
  }, [error])

  // 4xx ApiErrors: show the endpoint's own message instead of stale-daemon
  // or stale-daemon-code remedy copy, which would mislead the operator into
  // restarting the daemon when the response itself is informative.
  const is4xx =
    error instanceof ApiError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500

  const fb = is4xx
    ? { headline: error.message, remedy: null, detail: null, severity: 'error' as const }
    : resolveFallback(error, of)

  if (variant === 'inline') {
    return (
      <div
        role="alert"
        data-testid="error-state-inline"
        className={`flex flex-col gap-1 font-mono text-label ${fb.severity === 'warning' ? 'text-warn' : 'text-error'}`}
      >
        <span className="inline-flex items-center gap-1"><AlertTriangle size={12} strokeWidth={2} aria-hidden="true" /> {fb.headline}</span>
        {fb.remedy !== null && (
          <span className="text-muted-foreground text-micro">{fb.remedy}</span>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="self-start rounded border border-border px-2 py-0.5 text-label text-foreground hover:bg-foreground/5"
          >
            Retry
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      role="alert"
      data-testid="error-state"
      className="flex h-full flex-col items-center justify-center px-6 text-center"
    >
      <div className="max-w-lg border border-border bg-primary/10 p-6 text-left">
        <p className="text-body uppercase tracking-wide text-foreground">
          <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" className="mr-1 inline-block align-[-2px]" />
          {fb.headline}
        </p>
        {fb.remedy !== null && (
          <p className="mt-4 text-label text-muted-foreground">{fb.remedy}</p>
        )}
        {fb.detail !== null && (
          <p className="mt-3 whitespace-pre-wrap break-all text-label text-muted-foreground">
            {fb.detail}
          </p>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded border border-border px-3 py-1.5 text-label text-foreground hover:bg-primary/20"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  )
}
