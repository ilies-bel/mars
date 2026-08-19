/**
 * Render an id at display length while preserving any kind-prefix.
 *
 * Task ids minted by the queue come in two shapes:
 *   - bare 8-hex (legacy ideas, drafts, actionQueue rows): e.g. `79dc0844`
 *   - prefixed:   e.g. `mars-2e2bf341`, `reflect-09abf133`
 *
 * A naive `id.slice(0, 8)` clips a `mars-XXXXXXXX` id down to `mars-XXX`,
 * losing 5 hex chars of entropy and making the prefix uncopyable into
 * `mars show`. Preserve the `<prefix>-` and then take 8 hex chars after it.
 *
 * Live consequence of the naive form, seen on one screen of the Needs you
 * page: three failures for three different tasks all tagged `[task mars-634]`.
 *
 * This lives in `core/lib` rather than `cli/` because every surface that
 * renders an id needs it — the CLI, the action-queue view titles, and the
 * proposal bodies. Reach for it instead of writing a slice.
 */
export function shortId(id: string): string {
  const dash = id.indexOf('-')
  if (dash > 0 && dash < id.length - 1) {
    const prefix = id.slice(0, dash)
    // Only treat the leading segment as a kind-prefix if it is not itself a
    // hex chunk — that distinguishes `mars-XXXXXXXX` and `reflect-XXXXXXXX`
    // from idea ids like `578ab441-design-a-...` where the dash sits *after*
    // an 8-hex id and a slug follows.
    if (!/^[0-9a-f]+$/i.test(prefix)) {
      return id.slice(0, dash + 1 + 8)
    }
  }
  return id.slice(0, 8)
}
