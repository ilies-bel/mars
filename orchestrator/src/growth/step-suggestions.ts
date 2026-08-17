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
 */

import { createHash } from 'node:crypto'
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

/**
 * Persist one step suggestion as a draft proposal (source='growth'),
 * deduplicating by root-cause fingerprint exactly like
 * `reflector.ts`'s `persistOneSuggestion`: a repeat observation of the same
 * pattern appends evidence to the existing open draft instead of creating a
 * duplicate.
 */
const persistOneStepSuggestion = async (s: StepSuggestion): Promise<string> => {
  const fingerprint = fingerprintFor(s)
  const existing = await findOpenReflectionDraftByFingerprint(fingerprint, 'growth')
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
}

/** Evaluate every registered heuristic and persist each resulting suggestion as a draft proposal. */
export const persistStepSuggestions = async (
  entries: readonly ReflectCorpusEntry[],
): Promise<string[]> => {
  const suggestions = evaluateStepSuggestions(entries)
  const ids: string[] = []
  for (const s of suggestions) {
    ids.push(await persistOneStepSuggestion(s))
  }
  return ids
}
