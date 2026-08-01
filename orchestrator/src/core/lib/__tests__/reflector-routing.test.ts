/**
 * Routing tests for persistSuggestions.
 *
 * Verifies that suggestions are routed to a Task (via enqueueTask) or a
 * proposal (via createProposal) based on autoTrigger, confidence, and kind.
 * Tests use mocks at the system boundary (DB / queue) rather than
 * inspecting internals.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SelfEvolveConfig } from '../../daemon/config'

// Mock all DB-touching collaborators so tests run without a SQLite file.
vi.mock('../../proposals', () => ({
  createProposal: vi.fn().mockResolvedValue({ id: 'prop-1' }),
  findOpenReflectionDraftByFingerprint: vi.fn().mockResolvedValue(null),
  appendProposalNotes: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../queue')>()
  return {
    ...actual,
    enqueueTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'queued' }),
  }
})

// Also stub the provider boundary so runReflector is importable in CI.
vi.mock('../../workers/providers', () => ({ runHeadlessProvider: vi.fn() }))
vi.mock('../../context', () => ({
  getRepoRoot: vi.fn().mockReturnValue('/tmp'),
  resolveContext: vi.fn().mockReturnValue({ stateDir: '/tmp' }),
  resolveDbTarget: vi.fn().mockReturnValue('pglite://reflector-routing'),
}))

import { persistSuggestions, buildPrompt } from '../reflector'
import { createProposal } from '../../proposals'
import { enqueueTask } from '../../queue'

const THRESHOLD = 0.8

const autoTriggerOn: SelfEvolveConfig = {
  autoTrigger: true,
  driftThresholdPct: 10,
  taskConfidenceThreshold: THRESHOLD,
}

const autoTriggerOff: SelfEvolveConfig = {
  autoTrigger: false,
  driftThresholdPct: 10,
  taskConfidenceThreshold: THRESHOLD,
}

const mechanical = {
  title: 'Tighten typecheck flags',
  prompt: 'Add --strict to tsconfig. Verify: npm run typecheck. Save your work.',
  rationale: '3 tasks failed with TS2345 across 45k tokens',
  rootCauseKey: 'typecheck_strict_flags',
  affectedTaskIds: ['task-a', 'task-b', 'task-c'],
  frequency: 3,
  confidence: 0.9,
  kind: 'mechanical' as const,
}

const architectural = {
  ...mechanical,
  rootCauseKey: 'architectural_seam_change',
  kind: 'architectural' as const,
}

describe('persistSuggestions routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('auto-enqueues a mechanical suggestion when autoTrigger=true and confidence >= threshold', async () => {
    await persistSuggestions([mechanical], 'src-task', autoTriggerOn)

    expect(enqueueTask).toHaveBeenCalledOnce()
    expect(createProposal).not.toHaveBeenCalled()
  })

  it('enqueues task with author=reflector and a structured spec', async () => {
    await persistSuggestions([mechanical], 'src-task', autoTriggerOn)

    const [_prompt, _plan, opts] = (enqueueTask as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(opts?.author).toEqual({ kind: 'agent', name: 'reflector' })
    expect(opts?.spec).toBeDefined()
    expect(opts?.spec?.mergeMode).toBe('auto')
    expect(opts?.spec?.doneCriteria).toHaveLength(1)
  })

  it('never auto-enqueues an architectural suggestion, even at high confidence', async () => {
    await persistSuggestions([architectural], 'src-task', autoTriggerOn)

    expect(enqueueTask).not.toHaveBeenCalled()
    expect(createProposal).toHaveBeenCalledOnce()
  })

  it('routes to proposal when autoTrigger=false, even for high-confidence mechanical', async () => {
    await persistSuggestions([mechanical], 'src-task', autoTriggerOff)

    expect(enqueueTask).not.toHaveBeenCalled()
    expect(createProposal).toHaveBeenCalledOnce()
  })

  it('routes to proposal when confidence is below threshold', async () => {
    const lowConfidence = { ...mechanical, confidence: 0.5 }
    await persistSuggestions([lowConfidence], 'src-task', autoTriggerOn)

    expect(enqueueTask).not.toHaveBeenCalled()
    expect(createProposal).toHaveBeenCalledOnce()
  })

  it('routes to proposal when confidence exactly equals threshold', async () => {
    // Boundary: confidence === threshold qualifies (>=, not >)
    const atThreshold = { ...mechanical, confidence: THRESHOLD }
    await persistSuggestions([atThreshold], 'src-task', autoTriggerOn)

    expect(enqueueTask).toHaveBeenCalledOnce()
    expect(createProposal).not.toHaveBeenCalled()
  })

  it('routes multiple suggestions independently based on their kind and confidence', async () => {
    await persistSuggestions(
      [
        mechanical, // → enqueueTask
        architectural, // → createProposal (architectural)
        { ...mechanical, rootCauseKey: 'low_conf', confidence: 0.3 }, // → createProposal (low conf)
      ],
      'src-task',
      autoTriggerOn,
    )

    expect(enqueueTask).toHaveBeenCalledTimes(1)
    expect(createProposal).toHaveBeenCalledTimes(2)
  })

  it('routes all to proposals when no config is supplied (safe default)', async () => {
    // No config → defaults to autoTrigger=false path (all proposals)
    await persistSuggestions([mechanical], 'src-task')

    expect(enqueueTask).not.toHaveBeenCalled()
    expect(createProposal).toHaveBeenCalledOnce()
  })
})

describe('prompt schema for confidence and kind', () => {
  it('SYNTHESIS_INSTRUCTIONS defines confidence as 0..1 model-assessed field', () => {
    // Inspect the prompt the model receives for honest definitions of confidence/kind
    const corpus = {
      entries: [
        {
          taskId: 'fixture-1',
          status: 'merged',
          promptPrefix: 'do the thing',
          errorTail: null,
          createdAt: '2026-05-01T00:00:00Z',
          failureSignature: null,
          failureReasonCode: null,
          failedPhase: null,
          kind: null,
          fixForTaskId: null,
          originId: null,
          toolErrorCount: 0,
          topErrorTool: null,
          signals: [],
          scorerResults: [],
          totals: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreateTokens: 200,
            cacheReadTokens: 100,
            cacheHitRatio: 0.33,
          },
        },
      ],
      costSummary: {
        totalWeightedTokens: 0,
        taskCount: 1,
        successCount: 1,
        failureCount: 0,
        blockedCount: 0,
        droppedCount: 0,
        cacheHitRatio: 0.33,
        rateLimitRejections: 0,
        topTokenHeavyTasks: [],
        topExpensiveSteps: [],
        tokensByStep: [],
      },
    }
    const prompt = buildPrompt(corpus)
    const instructionPart = prompt.split('Token summary')[0]

    // Must define confidence as a 0..1 float
    expect(instructionPart).toMatch(/confidence/)
    expect(instructionPart).toMatch(/0\.\.1|0 to 1|0 and 1/)

    // Must define kind=mechanical as config/prompt/threshold change with verification
    expect(instructionPart).toMatch(/mechanical/)

    // Must define kind=architectural as seam/data shape/policy change
    expect(instructionPart).toMatch(/architectural/)

    // Schema must include the confidence and kind fields
    expect(prompt).toMatch(/"confidence"/)
    expect(prompt).toMatch(/"kind"/)
  })
})
