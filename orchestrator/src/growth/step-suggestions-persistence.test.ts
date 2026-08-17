import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createProposal, addProposalUserStory, findOpenReflectionDraftByFingerprint, appendProposalNotes } =
  vi.hoisted(() => ({
    createProposal: vi.fn(),
    addProposalUserStory: vi.fn(),
    findOpenReflectionDraftByFingerprint: vi.fn(),
    appendProposalNotes: vi.fn(),
  }))

vi.mock('../core/proposals.js', () => ({
  createProposal,
  addProposalUserStory,
  findOpenReflectionDraftByFingerprint,
  appendProposalNotes,
}))

import {
  registerStepSuggestionHeuristic,
  resetStepSuggestionHeuristicsForTests,
  persistStepSuggestions,
  resetGrowthContainerForTests,
} from './step-suggestions.js'
import type { StepSuggestionHeuristic } from './types.js'
import type { ReflectCorpusEntry } from '../core/lib/reflect-query.js'

/**
 * Proves `persistStepSuggestions` actually flows through the cordis event
 * (`ctx.serial('mars/growth.step-suggestion', ...)` -> `growthPersistencePlugin`
 * -> `createProposal`/`findOpenReflectionDraftByFingerprint`), not a direct
 * function call — by mocking only the DB-touching leaves in `core/proposals.js`
 * and asserting the cordis-dispatched side effects and the returned proposal
 * ids (which only come back correctly if `ctx.serial`'s return value threading
 * works end to end).
 */
describe('persistStepSuggestions — cordis event -> plugin -> proposal', () => {
  const heuristic: StepSuggestionHeuristic = {
    id: 'persistence-test-heuristic',
    describe: 'always fires once',
    evaluate: () => [
      {
        title: 'Add a thing',
        rootCauseKey: 'persistence_test_pattern',
        affectedTaskIds: ['t-1', 't-2'],
        rationale: 'seen twice',
        proposedStep: 'do-thing',
        prompt: 'do the thing. Save your work.',
      },
    ],
  }

  beforeEach(() => {
    createProposal.mockReset()
    addProposalUserStory.mockReset()
    findOpenReflectionDraftByFingerprint.mockReset()
    appendProposalNotes.mockReset()
    resetStepSuggestionHeuristicsForTests()
    resetGrowthContainerForTests()
    registerStepSuggestionHeuristic(heuristic)
  })

  it('files a fresh proposal when no open draft matches the fingerprint, and returns its id', async () => {
    findOpenReflectionDraftByFingerprint.mockResolvedValue(null)
    createProposal.mockResolvedValue({ id: 'prop-123' })
    addProposalUserStory.mockResolvedValue(undefined)

    const ids = await persistStepSuggestions([] as ReflectCorpusEntry[])

    expect(ids).toEqual(['prop-123'])
    expect(createProposal).toHaveBeenCalledTimes(1)
    expect(createProposal).toHaveBeenCalledWith(
      'Add a thing',
      expect.objectContaining({ source: 'growth', problem: 'seen twice' }),
    )
    expect(addProposalUserStory).toHaveBeenCalledWith('prop-123', 'Add a thing')
    expect(appendProposalNotes).not.toHaveBeenCalled()
  })

  it('appends evidence to an existing open draft instead of filing a duplicate', async () => {
    findOpenReflectionDraftByFingerprint.mockResolvedValue({ id: 'prop-existing', notes: '' })

    const ids = await persistStepSuggestions([] as ReflectCorpusEntry[])

    expect(ids).toEqual(['prop-existing'])
    expect(createProposal).not.toHaveBeenCalled()
    expect(appendProposalNotes).toHaveBeenCalledWith(
      'prop-existing',
      expect.stringContaining('t-1, t-2'),
    )
  })

  it('a fresh growth container (after reset) re-runs the plugin and still dispatches correctly', async () => {
    findOpenReflectionDraftByFingerprint.mockResolvedValue(null)
    createProposal.mockResolvedValue({ id: 'prop-1' })

    await persistStepSuggestions([] as ReflectCorpusEntry[])
    resetGrowthContainerForTests()
    createProposal.mockResolvedValue({ id: 'prop-2' })

    const ids = await persistStepSuggestions([] as ReflectCorpusEntry[])
    expect(ids).toEqual(['prop-2'])
  })
})
