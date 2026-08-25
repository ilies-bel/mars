/**
 * Drift gate for `conditionKinds` (ui/src/shared/schemas.ts).
 *
 * The daemon defines the three-class model in ADR-0094:
 *   - derived: derived on read from live state; no stored row to close.
 *   - decision: row-backed; closed atomically with the resolving mutation.
 *   - notice:   row-backed; closed durably on operator acknowledgement.
 *
 * `conditionKinds` is a hand-maintained UI-side mirror of `DERIVED_KINDS`
 * from `orchestrator/src/core/lib/action-queue-kinds.ts`. It drives whether
 * a row is hidden optimistically on verb success (decision/notice — yes,
 * derived — no). A drift here causes the bug described in the task that
 * introduced this file: derived-kind rows vanish on verb success and then
 * immediately reappear on the next refetch, misleading the operator.
 *
 * This gate recomputes the expected set directly from the orchestrator source
 * (via a source-text regex — the orchestrator modules pull in node-only
 * dependencies the browser bundle must never import; see the proposalSourceSchema
 * note in schemas.ts for the same constraint applied to proposal sources) and
 * asserts it matches `conditionKinds` exactly. A literal-array refactor in
 * the orchestrator source would break this regex extraction loudly (empty
 * match → assertion failure), not silently.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { conditionKinds } from './schemas'

const here = path.dirname(fileURLToPath(import.meta.url))
const orchestratorRoot = path.resolve(here, '../../../orchestrator/src')

function extractQuotedList(source: string, arrayStartPattern: RegExp): string[] {
  const match = arrayStartPattern.exec(source)
  if (!match) {
    throw new Error(`could not locate array literal matching ${arrayStartPattern} in source`)
  }
  const body = match[1]!
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('conditionKinds — drift gate against orchestrator sources', () => {
  it('matches DERIVED_KINDS in action-queue-kinds.ts exactly', () => {
    const source = readFileSync(
      path.join(orchestratorRoot, 'core/lib/action-queue-kinds.ts'),
      'utf8',
    )
    // Extract the quoted strings from the DERIVED_KINDS Set literal.
    const expected = extractQuotedList(
      source,
      /export const DERIVED_KINDS[^=]*=\s*new Set<ActionQueueKind>\(\[([\s\S]*?)\]\)/,
    )
    expect(expected.length).toBeGreaterThan(0)
    expect([...conditionKinds].sort()).toEqual([...expected].sort())
  })
})
