import { describe, it, expect, afterEach } from 'vitest'
import {
  registerStepSuggestionHeuristic,
  resetStepSuggestionHeuristicsForTests,
  getStepSuggestionHeuristics,
  evaluateStepSuggestions,
  DEFAULT_STEP_SUGGESTION_HEURISTICS,
} from './step-suggestions.js'
import type { StepSuggestionHeuristic } from './types.js'
import type { ReflectCorpusEntry } from '../core/lib/reflect-query.js'

afterEach(() => {
  resetStepSuggestionHeuristicsForTests()
})

const customHeuristic: StepSuggestionHeuristic = {
  id: 'custom-test-heuristic',
  describe: 'test-only heuristic',
  evaluate: () => [
    {
      title: 'Custom suggestion',
      rootCauseKey: 'custom_pattern',
      affectedTaskIds: ['t-9'],
      rationale: 'test rationale',
      proposedStep: 'custom-step',
      prompt: 'do the thing. Save your work.',
    },
  ],
}

describe('registerStepSuggestionHeuristic', () => {
  it('starts with exactly the default heuristics', () => {
    expect(getStepSuggestionHeuristics()).toEqual(DEFAULT_STEP_SUGGESTION_HEURISTICS)
  })

  it('adds a heuristic on top of the defaults', () => {
    registerStepSuggestionHeuristic(customHeuristic)
    const ids = getStepSuggestionHeuristics().map((h) => h.id)
    expect(ids).toContain('custom-test-heuristic')
    expect(ids.length).toBe(DEFAULT_STEP_SUGGESTION_HEURISTICS.length + 1)
  })

  it('rejects a duplicate id', () => {
    registerStepSuggestionHeuristic(customHeuristic)
    expect(() => registerStepSuggestionHeuristic(customHeuristic)).toThrow(/already registered/)
  })
})

describe('evaluateStepSuggestions', () => {
  it('unions results from every registered heuristic', () => {
    registerStepSuggestionHeuristic(customHeuristic)
    const entries: ReflectCorpusEntry[] = []
    const suggestions = evaluateStepSuggestions(entries)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].rootCauseKey).toBe('custom_pattern')
  })

  it('deduplicates by rootCauseKey across heuristics', () => {
    const dupHeuristic: StepSuggestionHeuristic = {
      ...customHeuristic,
      id: 'dup-heuristic',
    }
    registerStepSuggestionHeuristic(customHeuristic)
    registerStepSuggestionHeuristic(dupHeuristic)
    const suggestions = evaluateStepSuggestions([])
    expect(suggestions).toHaveLength(1)
  })
})
