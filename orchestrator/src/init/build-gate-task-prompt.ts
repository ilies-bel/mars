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
 * @throws When `entry.recipe` or `entry.recipe.verifyGate` is absent — callers
 *         must supply an entry that has both.
 */
export function buildGateTaskPrompt(
  entry: LeverRegistryEntry,
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

  const prompt = [
    `## Problem`,
    ``,
    recipe.problem,
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
