/**
 * Guard for the `// family: <name>` markers in `action-queue-recipes.ts`.
 *
 * ## Why the markers exist
 *
 * The still-`unaudited` action-queue kinds are being typed one family at a
 * time. Each family's slice has to edit two files: it declares its payload
 * contracts in `action-queue-payloads.ts`, then rewrites the matching recipe
 * entries in `action-queue-recipes.ts` to read typed fields instead of
 * `ctx.payload['someKey']`.
 *
 * `RECIPE_DEFINITIONS` is not ordered by family — its sections predate the
 * split — so a family's six entries can sit hundreds of lines apart. The
 * `// family: <name>` marker above each unaudited entry is how a slice finds
 * every entry it owns without re-deriving the mapping by hand.
 *
 * ## Why this guard exists
 *
 * A comment cannot be checked by the type system, and a marker that disagrees
 * with {@link UNAUDITED_KIND_FAMILY} is worse than no marker at all: it sends
 * a slice to edit an entry another slice owns, or hides an entry from the slice
 * that should have rewritten it. {@link UNAUDITED_KIND_FAMILY} stays the single
 * source of truth; these tests pin the file to it in both directions.
 *
 * The markers are scaffolding for one PRD. When the last kind flips to `typed`,
 * `UnauditedKind` becomes `never`, `UNAUDITED_KIND_FAMILY` empties, and this
 * file goes away with it — the "no marker on an audited kind" case below fails
 * loudly if a slice deletes its audit entry but leaves its markers behind.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTION_QUEUE_KINDS } from '../action-queue-kinds'
import { UNAUDITED_KIND_FAMILY } from '../action-queue-payloads'

const RECIPES_SRC = resolve(import.meta.dirname, '../action-queue-recipes.ts')

/** A `RECIPE_DEFINITIONS` entry key at its one nesting level: `  'kind': {`. */
const ENTRY = /^ {2}'?([a-z][a-z0-9-]*)'?: \{$/
/** The marker line directly above it: `  // family: <name>`. */
const MARKER = /^ {2}\/\/ family: (\S+)$/

/** Family marker found above each recipe entry, `null` when the entry has none. */
const markersByKind = (): Map<string, string | null> => {
  const lines = readFileSync(RECIPES_SRC, 'utf8').split('\n')
  const found = new Map<string, string | null>()

  for (const [i, line] of lines.entries()) {
    const entry = ENTRY.exec(line)
    if (!entry) continue
    const previous = i > 0 ? MARKER.exec(lines[i - 1] ?? '') : null
    found.set(entry[1] as string, previous?.[1] ?? null)
  }
  return found
}

describe('unaudited recipe entries are locatable from their family', () => {
  it('parses an entry for every registered kind', () => {
    // If the registry's formatting changes, the two assertions below would pass
    // vacuously. Fail here instead, where the cause is legible.
    const parsed = markersByKind()
    const missing = ACTION_QUEUE_KINDS.filter((kind) => !parsed.has(kind))
    expect(missing, 'kinds whose RECIPE_DEFINITIONS entry the parser did not find')
      .toEqual([])
  })

  it('marks every unaudited kind with the family that owns it', () => {
    const parsed = markersByKind()
    const wrong = Object.entries(UNAUDITED_KIND_FAMILY)
      .filter(([kind, family]) => parsed.get(kind) !== family)
      .map(([kind, family]) => `${kind}: expected '${family}', found '${parsed.get(kind)}'`)

    expect(wrong, 'unaudited kinds whose // family: marker is missing or wrong')
      .toEqual([])
  })

  it('leaves no marker behind on a kind that is no longer unaudited', () => {
    const parsed = markersByKind()
    const owned = new Set(Object.keys(UNAUDITED_KIND_FAMILY))
    const stale = [...parsed.entries()]
      .filter(([kind, family]) => family !== null && !owned.has(kind))
      .map(([kind]) => kind)

    expect(stale, 'kinds carrying a // family: marker after being typed')
      .toEqual([])
  })
})
