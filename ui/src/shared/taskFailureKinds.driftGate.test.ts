/**
 * Drift gate for `taskFailureKinds` (ui/src/shared/schemas.ts).
 *
 * The daemon computes "is this action-queue kind a task failure?" as a
 * COMPLEMENT: every kind in `ACTION_QUEUE_KINDS`
 * (orchestrator/src/core/lib/action-queue-kinds.ts) that is NOT in
 * `NON_TASK_FAILURE_KINDS` (orchestrator/src/core/daemon/view/action-queue.ts)
 * is a task failure. `taskFailureKinds` is a hand-maintained UI-side mirror
 * of that complement — nothing type-checks the two lists against each other,
 * so they can silently drift (and did: eleven kinds were missing as of
 * 2026-08-24).
 *
 * This test recomputes the expected complement directly from the orchestrator
 * source files (via a source-text regex, not an import — the orchestrator
 * modules pull in node-only dependencies the browser-bundled schemas.ts must
 * never import; see the proposalSourceSchema note above in schemas.ts for the
 * same constraint applied to proposal sources) and asserts it matches
 * `taskFailureKinds` exactly. A literal-array refactor in either orchestrator
 * source file would break this regex extraction loudly (empty match →
 * assertion failure), not silently.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { taskFailureKinds } from './schemas'

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

describe('taskFailureKinds — drift gate against orchestrator sources', () => {
  it('matches ACTION_QUEUE_KINDS minus NON_TASK_FAILURE_KINDS exactly', () => {
    const actionQueueKindsSource = readFileSync(
      path.join(orchestratorRoot, 'core/lib/action-queue-kinds.ts'),
      'utf8',
    )
    const allKinds = extractQuotedList(
      actionQueueKindsSource,
      /export const ACTION_QUEUE_KINDS = \[([\s\S]*?)\] as const/,
    )
    expect(allKinds.length).toBeGreaterThan(0)

    const actionQueueViewSource = readFileSync(
      path.join(orchestratorRoot, 'core/daemon/view/action-queue.ts'),
      'utf8',
    )
    const nonTaskFailureKinds = extractQuotedList(
      actionQueueViewSource,
      /const NON_TASK_FAILURE_KINDS = new Set\(\[([\s\S]*?)\]\)/,
    )
    expect(nonTaskFailureKinds.length).toBeGreaterThan(0)

    const expected = allKinds.filter((k) => !nonTaskFailureKinds.includes(k))

    expect([...taskFailureKinds].sort()).toEqual([...expected].sort())
  })
})
