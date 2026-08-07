/**
 * Tests that persistSuggestions emits one memory_packet per lesson
 * (PRD 6544c0a0, slice 4).
 *
 * Strategy: mock the LLM and store boundaries so the test exercises only
 * the packet-emission wiring inside reflector.ts through the public
 * persistSuggestions interface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store/memory-packet-store', () => ({
  insertMemoryPacket: vi.fn().mockResolvedValue({ id: 'mp-test' }),
  initMemoryPackets: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../proposals', () => ({
  createProposal: vi.fn().mockResolvedValue({ id: 'prop-1' }),
  findOpenReflectionDraftByFingerprint: vi.fn().mockResolvedValue(null),
  appendProposalNotes: vi.fn().mockResolvedValue(undefined),
}))

import { persistSuggestions } from '../reflector'
import { insertMemoryPacket } from '../../store/memory-packet-store'
import type { ReflectionSuggestion } from '../reflector'

const twoLessons: ReflectionSuggestion[] = [
  {
    title: 'Reduce cache misses on code step',
    prompt: 'Address cache-miss patterns in the code step. Save your work.',
    rationale: 'Observed in 2 tasks with high token spend.',
    rootCauseKey: 'cache_miss_code_step',
    affectedTaskIds: ['task-aaa', 'task-bbb'],
    frequency: 2,
    confidence: 0.8,
    kind: 'mechanical',
    outcome: {
      type: 'leverGap',
      leverGap: { proposedLeverId: 'cache.warmup-policy', family: 'workflow', whatItWouldControl: 'how the code step warms the prompt cache' },
    },
  },
  {
    title: 'Fix recurring typecheck failures',
    prompt: 'Resolve TS2345 errors seen across 3 tasks. Save your work.',
    rationale: '3 tasks failed on typecheck; same root cause each time.',
    rootCauseKey: 'typecheck_failure',
    affectedTaskIds: ['task-ccc', 'task-ddd', 'task-eee'],
    frequency: 3,
    confidence: 0.9,
    kind: 'architectural',
    outcome: {
      type: 'lever',
      lever: { id: 'verify.add-typecheck', currentValue: '(see mars verify-gate list)', proposedValue: 'add' },
    },
  },
]

describe('persistSuggestions — memory packet emission', () => {
  const insertSpy = vi.mocked(insertMemoryPacket)

  beforeEach(() => {
    insertSpy.mockClear()
    delete process.env.MARS_REFLECT_DISABLED
  })

  afterEach(() => {
    delete process.env.MARS_REFLECT_DISABLED
  })

  it('emits one memory_packet per lesson with domain general', async () => {
    await persistSuggestions(twoLessons, 'task-source-001')

    expect(insertSpy).toHaveBeenCalledTimes(2)

    // First lesson → packet with domain 'general', text from prompt, salience from confidence
    expect(insertSpy).toHaveBeenNthCalledWith(1, {
      domain: 'general',
      text: twoLessons[0].prompt,
      salience: 0.8,
      originArcId: null,
    })

    // Second lesson → packet with domain 'general', text from prompt, salience from confidence
    expect(insertSpy).toHaveBeenNthCalledWith(2, {
      domain: 'general',
      text: twoLessons[1].prompt,
      salience: 0.9,
      originArcId: null,
    })
  })

  it('falls back to salience 0.7 when the reflector did not score a lesson (confidence=0)', async () => {
    const unscoredLesson: ReflectionSuggestion = {
      title: 'Unscored observation',
      prompt: 'Do something to fix an observed pattern. Save your work.',
      rationale: null,
      rootCauseKey: 'unscored_pattern',
      affectedTaskIds: [],
      frequency: 1,
      confidence: 0,
      kind: 'mechanical',
      outcome: {
        type: 'leverGap',
        leverGap: { proposedLeverId: 'test.unscored', family: 'operator', whatItWouldControl: 'unscored pattern threshold' },
      },
    }

    await persistSuggestions([unscoredLesson], 'task-source-002')

    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(insertSpy).toHaveBeenCalledWith({
      domain: 'general',
      text: unscoredLesson.prompt,
      salience: 0.7,
      originArcId: null,
    })
  })

  it('skips packet emission when MARS_REFLECT_DISABLED=1', async () => {
    process.env.MARS_REFLECT_DISABLED = '1'

    await persistSuggestions(twoLessons, 'task-source-003')

    expect(insertSpy).not.toHaveBeenCalled()
  })
})
