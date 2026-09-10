/**
 * Primitive data access — a thin fetcher over the per-primitive facet
 * endpoint, mirroring entities/studio/api.ts.
 *
 * `GET /api/primitives/:name` (proxied to the daemon's
 * `GET /view/primitives/:name`) is the single source for a primitive's
 * identity, tool surface, and recent-N run history. The drawer renders
 * exactly what this returns — a read-only projection, never invented data.
 *
 * `GET /api/primitives` is the list. It reads the daemon's live primitive
 * registry, so it includes primitives an operator registered in their own
 * workflow code. The UI must ask for it rather than carry its own copy of
 * the names: a registered primitive that the UI does not know about
 * executes perfectly and is invisible, which is the worst of both.
 */

import type { PrimitiveDetail, PrimitiveSummary } from './types'

/** Fetches every primitive the daemon's registry currently holds. */
export const fetchPrimitives = async (
  fetchImpl: typeof fetch = fetch,
): Promise<PrimitiveSummary[]> => {
  const res = await fetchImpl('/api/primitives')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as PrimitiveSummary[] | { primitives: PrimitiveSummary[] }
  return Array.isArray(body) ? body : body.primitives
}

/** Fetches the facet payload for one primitive. Throws on non-2xx. */
export const fetchPrimitiveDetail = async (
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PrimitiveDetail> => {
  const res = await fetchImpl(`/api/primitives/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as PrimitiveDetail
}
