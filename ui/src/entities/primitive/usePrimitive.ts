/**
 * Primitive hooks — React Query wrapper over the primitive api module,
 * mirroring entities/studio/useStudio.ts.
 *
 * Query key: `['primitives', name]`. The facet is a cross-task read (not
 * scoped to one open task), so it does not join the `['task', openId]`
 * invalidation family; a fresh fetch on drawer open is the liveness
 * contract, matching the drawer's open/close cycle.
 */

import { useQuery } from '@tanstack/react-query'
import { fetchPrimitiveDetail } from './api'
import type { PrimitiveDetail, PrimitiveName } from './types'

interface PrimitiveDetailState {
  detail: PrimitiveDetail | undefined
  isLoading: boolean
  error: Error | null
}

/**
 * The facet payload for one primitive. Pass `enabled: false` when the caller
 * already holds a pre-loaded detail (test / static-rendering seam).
 */
export const usePrimitiveDetail = (
  name: PrimitiveName,
  enabled = true,
  fetchImpl?: typeof fetch,
): PrimitiveDetailState => {
  const query = useQuery<PrimitiveDetail>({
    queryKey: ['primitives', name],
    queryFn: () => fetchPrimitiveDetail(name, fetchImpl ?? fetch),
    enabled,
    retry: false,
  })
  return {
    detail: query.data,
    isLoading: enabled && query.isPending,
    error: query.error as Error | null,
  }
}
