/**
 * Human names for the member rows inside a cause cluster.
 *
 * A cluster header is one readable sentence; expanding it used to reveal
 * seventeen rows of `04b4e4e0-queue-position-ordering-for-the-cas-merg` — an
 * id welded to a slug that the daemon had already cut to 48 characters,
 * usually mid-word. The summary read like a product and the layer directly
 * beneath it read like a database.
 */

/**
 * Pulls a PRD's real title out of a slice-failure body.
 *
 * The daemon writes these bodies from a fixed template:
 *
 *   PRD <entityId> (<the PRD's real title>) could not be sliced: <error>
 *
 * That parenthetical is the only place the readable title survives; the
 * entityId beside it is the same title slugified and truncated. So the name
 * is not being invented or inferred — it is being read from the one field
 * that still holds it.
 *
 * Anchoring the match on the row's OWN entityId is what separates this from
 * scraping prose for something that looks like a title: the marker can only
 * match the sentence the daemon wrote about this exact row. A body that does
 * not carry the template returns null and the caller falls back, rather than
 * showing whatever happened to sit inside the first brackets.
 */
export const prdTitleFromBody = (
  body: string | null | undefined,
  entityId: string | null | undefined,
): string | null => {
  if (body == null || entityId == null || entityId === '') return null
  const marker = `PRD ${entityId} (`
  const start = body.indexOf(marker)
  if (start === -1) return null
  const from = start + marker.length
  // Walk to the parenthesis that closes the one the marker opened, rather
  // than the first one seen. PRD titles legitimately contain brackets —
  // "Merge trains (batched rebase+verify+ff)" — and stopping at the inner
  // ")" silently truncates the title to "Merge trains (batched rebase+verify+ff",
  // which is the exact class of half-a-string defect this helper exists to end.
  let depth = 1
  let end = -1
  for (let i = from; i < body.length; i++) {
    const ch = body[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return null
  const title = body.slice(from, end).trim()
  return title === '' ? null : title
}
