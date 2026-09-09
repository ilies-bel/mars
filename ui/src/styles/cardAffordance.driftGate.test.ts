/**
 * Drift gate for the card hover tint (ui/src/styles/index.css).
 *
 * A hover tint is a promise that the thing under the pointer is a target.
 * Every `.mars-card` used to take one, and almost none of them are targets:
 * measured across Triage, Control Room and KPI, every card is a plain <div>
 * with `cursor: auto`, and the ones that respond to a click respond on a
 * button inside them, never on the card. So the page lit up under the pointer
 * and nothing lit up was clickable. A reader learns to distrust the cue, and
 * then misses it where it is real.
 *
 * The tint is opt-in now, and opting in also commits the card to a pointer
 * cursor so the two halves of the promise cannot come apart again. This gate
 * holds both halves together: a future edit that re-broadens the selector, or
 * that keeps the tint while dropping the cursor, fails here rather than
 * shipping a page of false targets.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, 'index.css'), 'utf8')

/** Every selector that opens a rule block, ignoring comment bodies. */
const selectors = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.endsWith('{'))
  .map((line) => line.slice(0, -1).trim())

describe('card hover tint — drift gate', () => {
  it('never fills the ground of a bare .mars-card on hover', () => {
    // An edge that firms is a scanning cue and is honest on an inert card. A
    // ground that fills is how this UI says "target", so it may only appear
    // where there is one. Both used to fire on every card.
    const idx = css.indexOf('.mars-card:hover {')
    expect(idx).toBeGreaterThan(-1)
    const block = css.slice(idx, css.indexOf('}', idx))
    expect(block).toContain('border-color')
    expect(block).not.toContain('background-color')
  })

  it('tints only cards that have opted in', () => {
    expect(selectors).toContain('.mars-card--interactive:hover:not([class*="hover:bg-"])')
  })

  it('gives an opted-in card a pointer cursor in the same breath', () => {
    // Without this the tint says "target" while the cursor says "text", which
    // is the exact mismatch the broad rule shipped.
    expect(selectors).toContain('.mars-card--interactive')
    const block = css.slice(css.indexOf('.mars-card--interactive {'))
    expect(block.slice(0, block.indexOf('}'))).toContain('cursor: pointer')
  })
})
