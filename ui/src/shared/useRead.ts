import { useQuery, type QueryKey, type UseQueryOptions } from '@tanstack/react-query'
import { logFallbackError, resolveFallback, type Fallback } from './uiFallback'

/**
 * The query-state seam. One discriminated union over a React Query read, so
 * every view consumes loading / error / empty / ready the same way instead of
 * re-deriving four booleans (`isPending`, `isError`, `!data`, `length === 0`)
 * and re-running the dev-log effect by hand.
 *
 * The `error` arm carries an already-resolved {@link Fallback} (copy + remedy +
 * dev detail), so a caller renders `<FallbackSurface error={state.fallback} />`
 * with no further error plumbing.
 *
 * The `stale` arm is produced when a *background refetch* fails but prior data
 * is still available (`query.isError && query.data !== undefined`). Consumers
 * should render the stale data normally and surface a thin,
 * non-blocking `<ReconnectingStrip fallback={state.fallback} />` above it.
 * Only a true initial-load failure (no prior data) produces `kind: 'error'`
 * and warrants the full-pane `<FallbackSurface variant="pane">` takeover.
 */
export type RemoteState<T> =
  | { kind: 'loading' }
  | { kind: 'error'; fallback: Fallback; error: unknown }
  | { kind: 'stale'; data: T; fallback: Fallback; error: unknown }
  | { kind: 'empty' }
  | { kind: 'ready'; data: T }

interface UseReadOptions<T> {
  /** Human-readable surface label, woven into the fallback headline. */
  of: string
  /** Whether the query should fire. Mirrors React Query's `enabled`. */
  enabled?: boolean
  /** Re-fetch cadence in ms. Mirrors React Query's `refetchInterval`. */
  refetchInterval?: number
  /**
   * Treats a `ready` value as `empty`. Use for collection reads where an empty
   * array should render the empty-state, not a "ready" view of nothing.
   */
  isEmpty?: (data: T) => boolean
}

/**
 * Run a React Query read and project it onto a {@link RemoteState}. Logs the
 * error once (dev only) inside the seam, so call sites never repeat the
 * `useEffect(() => logFallbackError(error))` dance.
 *
 * A disabled query (`enabled: false`) reports `loading` — the caller is waiting
 * on a precondition (e.g. an unresolved project id), which reads the same as a
 * fetch in flight.
 */
export function useRead<T>(
  key: QueryKey,
  queryFn: UseQueryOptions<T>['queryFn'],
  opts: UseReadOptions<T>,
): RemoteState<T> {
  const query = useQuery<T>({
    queryKey: key,
    queryFn,
    enabled: opts.enabled ?? true,
    refetchInterval: opts.refetchInterval,
  })

  if (query.isError) {
    logFallbackError(query.error)
    const fallback = resolveFallback(query.error, opts.of)
    if (query.data !== undefined) {
      // Background refetch failed but prior data is still available — keep
      // data visible and surface a thin strip rather than a full-pane takeover.
      return { kind: 'stale', data: query.data, fallback, error: query.error }
    }
    return { kind: 'error', fallback, error: query.error }
  }

  if (query.data === undefined) {
    return { kind: 'loading' }
  }

  if (opts.isEmpty?.(query.data)) {
    return { kind: 'empty' }
  }

  return { kind: 'ready', data: query.data }
}
