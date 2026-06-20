import type { Fallback } from '@/shared/uiFallback'

interface ReconnectingStripProps {
  /** The resolved fallback that describes why reconnection is needed. */
  fallback: Fallback
}

/**
 * A thin, non-blocking full-width warning bar shown when a background refetch
 * fails while prior data is still available (the `stale` arm of
 * {@link RemoteState}).
 *
 * It renders ABOVE its sibling content — never replacing it — so the user keeps
 * the last good data visible while the UI reconnects. The strip clears
 * automatically when the next successful poll replaces the `stale` state with
 * `ready` (or `empty`), causing the parent to stop rendering this component.
 *
 * Use alongside `useRead`'s `stale` arm:
 * ```tsx
 * case 'stale':
 *   return (
 *     <>
 *       <ReconnectingStrip fallback={state.fallback} />
 *       <MyDataView data={state.data} />
 *     </>
 *   )
 * ```
 */
export const ReconnectingStrip = ({ fallback }: ReconnectingStripProps) => {
  const colorClass =
    fallback.severity === 'warning'
      ? 'border-warn/40 bg-warn/10 text-warn'
      : 'border-error/40 bg-error/10 text-error'

  return (
    <div
      role="alert"
      data-testid="reconnecting-strip"
      className={`flex shrink-0 items-center gap-2 border-b px-4 py-1.5 font-mono text-[11px] ${colorClass}`}
    >
      <span>{fallback.headline}</span>
      {fallback.remedy !== null && (
        <span className="opacity-70">{fallback.remedy}</span>
      )}
    </div>
  )
}
