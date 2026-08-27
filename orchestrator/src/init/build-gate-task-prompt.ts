/**
 * build-gate-task-prompt — construct the enqueue payload for the first missing
 * verify-gate discovered during onboarding.
 *
 * The function is intentionally narrow: it only handles lever-registry entries
 * that carry a `recipe.verifyGate` field (all entries returned by
 * `computeMissingGates` meet this invariant by construction).
 */

import type { LeverRegistryEntry } from '../core/lib/lever-registry.js'
import type { TaskSpec } from '../core/lib/queue-primitives.js'

/**
 * Build the coder prompt and structured TaskSpec for an onboarding task that
 * installs the tooling backing a missing verify gate.
 *
 * @param entry A lever-registry entry whose `recipe` and `recipe.verifyGate`
 *              are guaranteed to be present (ensured by `computeMissingGates`).
 * @param opts.isFallback When `true`, the recipe's `problem` text is replaced
 *              with a neutral statement that claims only what Mars actually
 *              knows — that no gate of this name is configured — rather than
 *              asserting a property of the repo that was not verified (e.g.
 *              "Your repo has TypeScript files"). Set this when
 *              `computeMissingGates` returns `isFallback: true`, meaning the
 *              entry was chosen because no recipe's predicate matched.
 * @throws When `entry.recipe` or `entry.recipe.verifyGate` is absent — callers
 *         must supply an entry that has both.
 */
export function buildGateTaskPrompt(
  entry: LeverRegistryEntry,
  opts?: { isFallback?: boolean },
): { prompt: string; spec: TaskSpec } {
  const recipe = entry.recipe
  if (!recipe) {
    throw new Error(
      `[build-gate-task-prompt] entry '${entry.id}' has no recipe — only verify-family entries with a recipe are supported`,
    )
  }
  const vg = recipe.verifyGate
  if (!vg) {
    throw new Error(
      `[build-gate-task-prompt] entry '${entry.id}' recipe has no verifyGate — cannot build a task without a gate definition`,
    )
  }

  const verifyCmd = [vg.cmd, ...vg.args].join(' ')

  const stepsText =
    recipe.setupSteps.length > 0
      ? recipe.setupSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '(no setup steps listed)'

  // On the fallback path, use a neutral problem statement that makes no claim
  // about the repo's stack — only that the gate is not yet configured.
  const problemText = opts?.isFallback
    ? `No ${vg.name} gate is configured. Adding one will catch errors before merge.`
    : recipe.problem

  const prompt = [
    `## Problem`,
    ``,
    problemText,
    ``,
    `## Solution`,
    ``,
    recipe.solution,
    ``,
    `## Setup steps`,
    ``,
    stepsText,
    ``,
    `## Verification`,
    ``,
    `After completing the setup steps, confirm the gate passes:`,
    ``,
    `\`\`\``,
    verifyCmd,
    `\`\`\``,
    ``,
    `The verify command must exit 0 with no errors before this task can merge.`,
    ``,
    `Save your work: stage and commit every file you touch.`,
  ].join('\n')

  const spec: TaskSpec = {
    files: [],
    verifyCmd,
    doneCriteria: ['The new gate passes in a clean run'],
    mergeMode: 'auto',
  }

  return { prompt, spec }
}
