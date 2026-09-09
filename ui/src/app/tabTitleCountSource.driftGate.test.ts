/**
 * Drift gate for the tab-title badge's count source (ui/src/app/App.tsx).
 *
 * The operator sees "how many things need me" on four surfaces at once: the
 * sidebar badge, the board-header chip, the top-right chip, and the browser
 * tab. The first three all read `useCounts().needsYou` — the unified counts
 * endpoint that Shell.tsx calls "the single source of truth". The tab used to
 * be a fifth surface with its own arithmetic:
 *
 *     const { items: aqItems } = useActionQueue()
 *     useTabTitleBadge(countNeedsYou(aqItems), sseConnected)
 *
 * `countNeedsYou(items, serverGroups?)` takes two arguments; passing only
 * `items` silently drops every `type: 'group'` row. Measured live against a
 * real queue, the tab read `(11)` while the three on-screen chips all read
 * `38` for the same state. The tab title is the operator's only signal while
 * the window is backgrounded, so it is precisely the surface that must not
 * disagree — and the one where a disagreement is hardest to notice, because
 * the contradicting number is off-screen by definition.
 *
 * A parity test that renders both surfaces cannot catch this: the bug is not
 * a wrong computation, it is a *different source*. So this gate asserts the
 * source shape directly — App.tsx must feed the badge from useCounts(), and
 * must not recompute a needs-you count of its own.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(path.join(here, 'App.tsx'), 'utf8')

describe('tab-title badge count source — drift gate', () => {
  it('reads the count from useCounts(), the same hook the visible chips use', () => {
    expect(appSource).toMatch(/const \{ needsYou[^}]*\} = useCounts\(\)/)
    expect(appSource).toMatch(/useTabTitleBadge\(\s*needsYou\s*,/)
  })

  it('does not recompute a needs-you count of its own', () => {
    expect(appSource).not.toMatch(/countNeedsYou/)
  })

  it('suppresses the badge until the count is a real answer, not a placeholder', () => {
    // useCounts() returns zeros with known:false while the first fetch is in
    // flight and when it fails. Zero is indistinguishable from "all clear" in
    // the tab bar, so the badge must gate on `known` as well as the SSE
    // connection — the same reasoning that already drops the prefix while
    // disconnected rather than showing a stale, confident number.
    expect(appSource).toMatch(/useTabTitleBadge\(\s*needsYou\s*,\s*sseConnected && known\s*\)/)
  })
})
