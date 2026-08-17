/**
 * Step-suggestion service — the "grow with the user" surface (TARGET-
 * ARCHITECTURE.md, growth section). Inspects completed task history and
 * emits draft proposals suggesting NEW WORKFLOW STEPS, reusing the same
 * draft-proposal machinery reflect/proposals already use so these findings
 * land on the exact same operator surface (`mars proposal list`, the
 * action-queue's `draft-proposal` rows) as reflection output.
 *
 * Registrable: `registerStepSuggestionHeuristic` lets a workflow author add
 * heuristics beyond the opinionated default set without editing this file.
 *
 * PERSISTENCE IS CORDIS-DISPATCHED, not a direct function call: evaluating a
 * heuristic and persisting its suggestion are two different concerns (a pure
 * data transform vs. a side-effecting write), so `persistStepSuggestions`
 * `ctx.serial`-emits `'mars/growth.step-suggestion'` on a small module-private
 * cordis `Context` for each suggestion, and a single cordis PLUGIN —
 * `growthPersistencePlugin`, config-validated via zod (standard-schema, as
 * cordis intends) — listens and does the write. A future second listener
 * (e.g. a live UI feed of newly-proposed steps) is one `ctx.on(...)` away,
 * with zero change to this file's persistence logic.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Context } from '@mars/workflow'
import type { Context as PluginCtx, Plugin } from '@mars/workflow'
import '../workflows/cordis-types' // declares Events['mars/growth.step-suggestion']
import {
  createProposal,
  addProposalUserStory,
  findOpenReflectionDraftByFingerprint,
  appendProposalNotes,
} from '../core/proposals.js'
import type { ReflectCorpusEntry } from '../core/lib/reflect-query.js'
import { DEFAULT_STEP_SUGGESTION_HEURISTICS } from './heuristics.js'
import type { StepSuggestion, StepSuggestionHeuristic } from './types.js'

export type { StepSuggestion, StepSuggestionHeuristic } from './types.js'
export { DEFAULT_STEP_SUGGESTION_HEURISTICS } from './heuristics.js'

let registeredHeuristics: StepSuggestionHeuristic[] = [...DEFAULT_STEP_SUGGESTION_HEURISTICS]

/** Register an additional heuristic on top of the default set. */
export const registerStepSuggestionHeuristic = (heuristic: StepSuggestionHeuristic): void => {
  if (registeredHeuristics.some((h) => h.id === heuristic.id)) {
    throw new Error(`step-suggestion heuristic id already registered: '${heuristic.id}'`)
  }
  registeredHeuristics.push(heuristic)
}

/** Current heuristic set (defaults + anything registered since). */
export const getStepSuggestionHeuristics = (): readonly StepSuggestionHeuristic[] =>
  registeredHeuristics

/** Test-only: reset to the opinionated default set. */
export const resetStepSuggestionHeuristicsForTests = (): void => {
  registeredHeuristics = [...DEFAULT_STEP_SUGGESTION_HEURISTICS]
}

/**
 * Run every registered heuristic over the given task-history window and
 * return the union of suggestions, deduplicated by `rootCauseKey` (first
 * heuristic to report a given key wins — heuristics are expected to use
 * distinct keys, but a collision should never produce two proposals for the
 * same pattern).
 */
export const evaluateStepSuggestions = (
  entries: readonly ReflectCorpusEntry[],
): StepSuggestion[] => {
  const seen = new Set<string>()
  const out: StepSuggestion[] = []
  for (const heuristic of registeredHeuristics) {
    for (const suggestion of heuristic.evaluate(entries)) {
      if (seen.has(suggestion.rootCauseKey)) continue
      seen.add(suggestion.rootCauseKey)
      out.push(suggestion)
    }
  }
  return out
}

const fingerprintFor = (s: StepSuggestion): string =>
  createHash('sha256').update(`growth:${s.rootCauseKey}:`).digest('hex').slice(0, 32)

/** Config for {@link growthPersistencePlugin} — validated via zod (standard-schema). */
const GrowthPersistenceConfig = z.object({
  /**
   * When true (the default), a repeat observation of the same root-cause
   * pattern appends evidence to the existing open draft instead of filing a
   * duplicate — exactly like `reflector.ts`'s `persistOneSuggestion`. `false`
   * always files a fresh draft; only ever useful for tests.
   */
  dedupeByFingerprint: z.boolean().optional(),
})
type GrowthPersistenceConfig = z.output<typeof GrowthPersistenceConfig>

/**
 * The persistence plugin: listens for `'mars/growth.step-suggestion'` and
 * turns each one into a draft proposal (source='growth'). Registered once on
 * the module-private growth container by {@link getGrowthContainer}.
 */
const growthPersistencePlugin: Plugin<GrowthPersistenceConfig> = {
  name: 'growth-persistence',
  Config: GrowthPersistenceConfig,
  apply(pluginCtx: PluginCtx, config: GrowthPersistenceConfig) {
    const dedupe = config.dedupeByFingerprint ?? true
    pluginCtx.on('mars/growth.step-suggestion', async (s: StepSuggestion) => {
      const fingerprint = fingerprintFor(s)
      const existing = dedupe
        ? await findOpenReflectionDraftByFingerprint(fingerprint, 'growth')
        : null
      if (existing) {
        await appendProposalNotes(
          existing.id,
          `Also observed in: ${s.affectedTaskIds.join(', ')}\n${s.rationale}`,
        )
        return existing.id
      }

      const proposal = await createProposal(s.title, {
        source: 'growth',
        author: { kind: 'agent', name: 'growth' },
        problem: s.rationale,
        solution: s.prompt,
        notes: `Proposed step: ${s.proposedStep}`,
        fingerprint,
      })
      await addProposalUserStory(proposal.id, s.title)
      return proposal.id
    })
  },
}

// Module-private cordis Context — the event bus a suggestion becomes a
// proposal through. Lazily created (and awaited into ACTIVE) on first use so
// importing this module never has a side effect.
let growthContainer: Context | null = null

const getGrowthContainer = async (): Promise<Context> => {
  if (!growthContainer) {
    const ctx = new Context()
    await ctx.plugin(growthPersistencePlugin, {})
    growthContainer = ctx
  }
  return growthContainer
}

/**
 * Test-only: drop the memoised growth container so the next call builds a
 * fresh one (and re-runs `growthPersistencePlugin`'s `apply`).
 */
export const resetGrowthContainerForTests = (): void => {
  growthContainer = null
}

/**
 * Evaluate every registered heuristic and persist each resulting suggestion
 * as a draft proposal. Each suggestion is dispatched as a
 * `'mars/growth.step-suggestion'` cordis event (`ctx.serial`, so the
 * persistence listener's return value — the proposal id — comes straight
 * back) rather than called directly; see the module doc comment.
 */
export const persistStepSuggestions = async (
  entries: readonly ReflectCorpusEntry[],
): Promise<string[]> => {
  const suggestions = evaluateStepSuggestions(entries)
  const ctx = await getGrowthContainer()
  const ids: string[] = []
  for (const s of suggestions) {
    ids.push(await ctx.serial('mars/growth.step-suggestion', s))
  }
  return ids
}
