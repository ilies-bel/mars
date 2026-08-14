/**
 * Verify-output distillation tests for buildArcPrompt (slice 4 of PRD 74d76a78).
 *
 * These tests confirm that the arc-reflection prompt uses distillObservation
 * on task verify output rather than embedding the raw string verbatim:
 *
 * 1. The 200k-char noisy PASS-line fixture (from slice 3) is collapsed to a
 *    tiny summary — the total prompt is well under 10 KB.
 * 2. A FAIL line present in the verify output is preserved verbatim in the
 *    prompt even after distillation.
 * 3. The raw repeated PASS string does not appear verbatim in the prompt.
 */

import { describe, expect, it } from 'vitest'
import { buildArcPrompt } from '../lib/deep-reflector'
import type { DeepReflectArc } from '../lib/deep-reflect-query'

// ── Minimal fixtures ─────────────────────────────────────────────────────────

const makeTaskEntry = (
  taskId: string,
  verifyOutput: string | null = null,
): DeepReflectArc['tasks'][number] => ({
  taskId,
  status: 'done',
  prompt: 'implement the feature',
  error: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T01:00:00.000Z',
  kind: 'task',
  fixForTaskId: null,
  signals: [],
  scorerResults: [],
  totals: {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    cacheHitRatio: 0,
  },
  conversation: [],
  verifyOutput,
  hasTranscript: false,
  toolCallCounts: {},
  transcriptNotes: [],
})

const makeArc = (tasks: DeepReflectArc['tasks']): DeepReflectArc => ({
  originId: 'mars-distill-test',
  tasks,
  statusMix: { done: tasks.length },
  taskCount: tasks.length,
  totals: {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalWeightedTokens: 1050,
    cacheHitRatio: 0,
    eventCount: 0,
  },
  lastActivity: '2025-01-01T01:00:00.000Z',
  stepTimeline: [],
  toolInvokedErrors: [],
  operatorContext: null,
})

// ── Noisy fixture from slice 3 ────────────────────────────────────────────────
// 200k chars of PASS lines — the canonical "noisy fixture" the distillation
// module was built to handle. distill/observation collapses consecutive PASS
// lines into a single count summary.
const buildNoisyFixture = (): string => {
  const passLine = 'PASS src/some/very/nested/module.test.ts (12ms)'
  const reps = Math.ceil(200_000 / (passLine.length + 1))
  return Array.from({ length: reps }, () => passLine).join('\n').slice(0, 200_000)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildArcPrompt — verify output distillation', () => {
  it('verify section adds < 1 KB when input is the 200k noisy PASS-line fixture', () => {
    const noisyVerifyOutput = buildNoisyFixture()
    expect(noisyVerifyOutput.length).toBeGreaterThanOrEqual(200_000)

    // Baseline: arc without verify output
    const arcNoVerify = makeArc([makeTaskEntry('mars-base')])
    const basePrompt = buildArcPrompt(arcNoVerify)

    // Arc with 200k noisy PASS-line verify output
    const arcWithNoise = makeArc([makeTaskEntry('mars-noisy-task', noisyVerifyOutput)])
    const noisyPrompt = buildArcPrompt(arcWithNoise)

    // After distillation, the PASS lines collapse to a tiny summary (~50 chars).
    // The verify section should add at most 1 KB over the baseline.
    // Without distillation the old truncation would add ≥ 8 000 bytes (VERIFY_OUTPUT_CAP_CHARS).
    const overhead = Buffer.byteLength(noisyPrompt, 'utf8') - Buffer.byteLength(basePrompt, 'utf8')
    expect(overhead).toBeLessThan(1_000)
  })

  it('preserves a FAIL line verbatim in the distilled arc prompt', () => {
    const failLine = 'FAIL src/core/queue-fix-tasks.test.ts'
    const noise = Array.from({ length: 100 }, () => 'PASS src/unrelated.test.ts (1ms)').join('\n')
    const verifyOutput = `${noise}\n${failLine}\n${noise}`

    const arc = makeArc([makeTaskEntry('mars-fail-task', verifyOutput)])
    const prompt = buildArcPrompt(arc)

    // The failing test file name must survive distillation intact.
    expect(prompt).toContain(failLine)
  })

  it('does not embed the raw repeated PASS string verbatim', () => {
    const noisyVerifyOutput = buildNoisyFixture()
    // Take a 5-line slice — long enough to prove it was NOT kept verbatim.
    const rawSlice = noisyVerifyOutput.split('\n').slice(0, 5).join('\n')

    const arc = makeArc([makeTaskEntry('mars-raw-check', noisyVerifyOutput)])
    const prompt = buildArcPrompt(arc)

    // The raw PASS lines must not appear verbatim — they were collapsed.
    expect(prompt).not.toContain(rawSlice)
  })
})
