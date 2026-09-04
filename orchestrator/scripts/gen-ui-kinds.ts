#!/usr/bin/env tsx
/**
 * Generates ui/src/shared/action-queue-kinds.generated.ts from the orchestrator
 * source of truth. The generated file is the single canonical copy of the
 * `conditionKinds` and `taskFailureKinds` constants — hand-editing it is
 * pointless; it will be overwritten on the next codegen run.
 *
 * Run with:
 *   npm --prefix orchestrator run mars:gen:ui-kinds
 *
 * Used by:
 *   - npm --prefix orchestrator run mars:bundle:refresh  (author-time refresh)
 *   - .github/workflows/template-sync-check.yml          (CI drift gate)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const orchestratorSrc = path.resolve(here, '../src')
const outputPath = path.resolve(here, '../../ui/src/shared/action-queue-kinds.generated.ts')

function extractQuotedList(source: string, pattern: RegExp): string[] {
  const match = pattern.exec(source)
  if (!match) {
    throw new Error(`could not locate array literal matching ${pattern} in source`)
  }
  const body = match[1]!
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

const actionQueueKindsSource = readFileSync(
  path.join(orchestratorSrc, 'core/lib/action-queue-kinds.ts'),
  'utf8',
)

const allKinds = extractQuotedList(
  actionQueueKindsSource,
  /export const ACTION_QUEUE_KINDS = \[([\s\S]*?)\] as const/,
)

const derivedKinds = extractQuotedList(
  actionQueueKindsSource,
  /export const DERIVED_KINDS[^=]*=\s*new Set<ActionQueueKind>\(\[([\s\S]*?)\]\)/,
)

const actionQueueViewSource = readFileSync(
  path.join(orchestratorSrc, 'core/daemon/view/action-queue.ts'),
  'utf8',
)

const nonTaskFailureKinds = new Set(
  extractQuotedList(
    actionQueueViewSource,
    /const NON_TASK_FAILURE_KINDS = new Set\(\[([\s\S]*?)\]\)/,
  ),
)

const taskFailureKindList = allKinds.filter((k) => !nonTaskFailureKinds.has(k))

const formatList = (items: string[]): string =>
  items.map((k) => `  '${k}',`).join('\n')

const output = `// GENERATED — do not edit by hand.
// Regenerate with: npm --prefix orchestrator run mars:gen:ui-kinds
//
// Source of truth:
//   orchestrator/src/core/lib/action-queue-kinds.ts  (DERIVED_KINDS, ACTION_QUEUE_KINDS)
//   orchestrator/src/core/daemon/view/action-queue.ts (NON_TASK_FAILURE_KINDS)
//
// conditionKinds.driftGate.test.ts and taskFailureKinds.driftGate.test.ts assert
// that this file's constants match the orchestrator sources exactly.

/**
 * Mirror of DERIVED_KINDS from orchestrator/src/core/lib/action-queue-kinds.ts.
 *
 * Derived kinds are derived on read from live system state — there is no stored
 * row to close. Whether a derived-kind row survives a verb depends entirely on
 * whether the underlying condition still holds after the verb. DO NOT optimistically
 * hide derived-kind rows on verb success; let the refetched feed decide.
 */
export const conditionKinds = [
${formatList(derivedKinds)}
] as const

/**
 * Mirror of ACTION_QUEUE_KINDS minus NON_TASK_FAILURE_KINDS from
 * orchestrator/src/core/daemon/view/action-queue.ts.
 *
 * Every action-queue kind NOT in NON_TASK_FAILURE_KINDS is classified as a task
 * failure. This list backs the \`taskFailureItemSchema\` z.enum in schemas.ts —
 * adding a kind here changes how rows parse, not just how they group.
 */
export const taskFailureKinds = [
${formatList(taskFailureKindList)}
] as const
`

writeFileSync(outputPath, output, 'utf8')
console.log(`Generated ${path.relative(process.cwd(), outputPath)}`)
console.log(`  conditionKinds:   ${derivedKinds.length} kinds`)
console.log(`  taskFailureKinds: ${taskFailureKindList.length} kinds`)
