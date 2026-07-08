/**
 * Primitive data access — a thin fetcher over the per-primitive facet
 * endpoint, mirroring entities/studio/api.ts.
 *
 * `GET /api/primitives/:name` (proxied to the daemon's
 * `GET /view/primitives/:name`) is the single source for a primitive's
 * identity, tool surface, and recent-N run history. The drawer renders
 * exactly what this returns — a read-only projection, never invented data.
 */

import type { PrimitiveDetail } from './types'

/** Fetches the facet payload for one primitive. Throws on non-2xx. */
export const fetchPrimitiveDetail = async (
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PrimitiveDetail> => {
  const res = await fetchImpl(`/api/primitives/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as PrimitiveDetail
}
