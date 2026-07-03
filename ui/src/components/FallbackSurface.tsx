import { useEffect } from 'react'
import { logFallbackError, resolveFallback, type Fallback } from '@/shared/uiFallback'

type FallbackVariant = 'pane' | 'inline'

interface FallbackSurfaceProps {
  /**
   * Either a raw thrown value (resolved here) or an already-resolved
   * {@link Fallback}. Hooks that resolve eagerly (the `useRead` error arm)
   * pass the latter; ad-hoc call sites pass the raw error.
   */
  error: unknown
  /**
   * Human-readable name of the section that failed to load (e.g. 'trace
   * events'). Woven into the headline for non-`ApiError` throws. Ignored when
   * `error` is already a resolved `Fallback`.
   */
  of: string
  /**
   * `pane` — a centred full-region banner (the former `ApiErrorPanel`).
   * `inline` — a compact two-line block for sub-sections (traces, origins).
   */
  variant?: FallbackVariant
}

const isResolved = (e: unknown): e is Fallback =>
  typeof e === 'object' && e !== null && 'headline' in e && 'severity' in e

/**
 * The single render seam for the error half of a UI fallback surface. Reads a
 * {@link Fallback} (resolving the raw error if needed), logs once in dev, and
 * renders the calm headline + remedy, plus raw detail in dev only.
 *
 * Replaces `ApiErrorPanel`, `getFallbackCopy` inline rendering, and the cloned
 * EventsPage error markup — every error surface now flows through here, so copy,
 * remedy, the dev/prod split, and logging live in exactly one place.
 */
export const FallbackSurface = ({ error, of, variant = 'pane' }: FallbackSurfaceProps) => {
  const fb = isResolved(error) ? error : resolveFallback(error, of)

  useEffect(() => {
    logFallbackError(error)
  }, [error])

  if (variant === 'inline') {
    return (
      <dd className={fb.severity === 'warning' ? 'text-warn' : 'text-error'} role="alert">
        {fb.headline}
        {fb.remedy !== null ? ` ${fb.remedy}` : null}
        {fb.detail !== null ? ` ${fb.detail}` : null}
      </dd>
    )
  }

  return (
    <div
      role="alert"
      data-testid="api-error-panel"
      className="flex h-full flex-col items-center justify-center px-6 text-center"
    >
      <div className="max-w-lg border border-iron/40 bg-iron/10 p-6 font-mono text-left">
        <p className="text-[13px] uppercase tracking-wide text-fg">{fb.headline}</p>
        {fb.remedy !== null && (
          <p className="mt-4 text-[11px] text-muted">{fb.remedy}</p>
        )}
        {fb.detail !== null && (
          <p className="mt-3 whitespace-pre-wrap break-all text-[11px] text-iron">
            {fb.detail}
          </p>
        )}
      </div>
    </div>
  )
}
