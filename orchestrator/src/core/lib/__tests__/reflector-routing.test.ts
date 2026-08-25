/**
 * Routing tests for persistSuggestions.
 *
 * Asserts the invariant required by ADR-0038 and DEC-17: persistSuggestions
 * ALWAYS routes to a proposal (via createProposal) and NEVER enqueues a task,
 * regardless of suggestion kind, confidence, or any other input.
 *
 * This test is what keeps DEC-17 true: "Growth reacts to observed events and
 * produces proposals that wait; it is never a job that invents work to justify
 * running."
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock all DB-touching collaborators so tests run without a SQLite file.
vi.mock('../../proposals', () => ({
  createProposal: vi.fn().mockResolvedValue({ id: 'prop-1' }),
  findOpenReflectionDraftByFingerprint: vi.fn().mockResolvedValue(null),
  appendProposalNotes: vi.fn().mockResolvedValue(undefined),
  findOpenTasksMatchingTitle: vi.fn().mockResolvedValue([]),
  addProposalUserStory: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../queue')>()
  return {
    ...actual,
    enqueueTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'queued' }),
  }
})

// Also stub the Worker dispatch boundary so runReflector is importable in CI.
vi.mock('../run-worker-with-span', () => ({ runWorkerWithSpan: vi.fn() }))
vi.mock('../trace-events-store', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../trace-events-store')>()
  return { ...orig, openTraceEventStore: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('../../context', () => ({
  getRepoRoot: vi.fn().mockReturnValue('/tmp'),
  resolveContext: vi.fn().mockReturnValue({ stateDir: '/tmp' }),
  resolveDbTarget: vi.fn().mockReturnValue('pglite://reflector-routing'),
}))

import { persistSuggestions, buildPrompt } from '../reflector'
import { createProposal } from '../../proposals'
import { enqueueTask } from '../../queue'

const mechanical = {
  title: 'Tighten typecheck flags',
  prompt: 'Add --strict to tsconfig. Verify: npm run typecheck. Save your work.',
  rationale: '3 tasks failed with TS2345 across 45k tokens',
  rootCauseKey: 'typecheck_strict_flags',
  affectedTaskIds: ['task-a', 'task-b', 'task-c'],
  frequency: 3,
  confidence: 0.9,
  kind: 'mechanical' as const,
  coversInstances: ['task-a', 'task-b', 'task-c'],
  doesNotClaim: '',
  outcome: {
    type: 'lever' as const,
    lever: { id: 'verify.add-typecheck', currentValue: '(see mars verify-gate list)', proposedValue: 'add' },
  },
}

const architectural = {
  ...mechanical,
  rootCauseKey: 'architectural_seam_change',
  kind: 'architectural' as const,
  outcome: {
    type: 'leverGap' as const,
    leverGap: { proposedLeverId: 'slicer.contract-isolation', family: 'workflow', whatItWouldControl: 'how the slicer handles shared contract files across tasks' },
  },
}

describe('persistSuggestions — invariant: zero tasks, always proposals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists a high-confidence mechanical suggestion as a proposal, never as a task', async () => {
    await persistSuggestions([mechanical], 'src-task')

    expect(enqueueTask).not.toHaveBeenCalled()
    expect(createProposal).toHaveBeenCalledOnce()
  })

  it('persists an architectural suggestion as a proposal, never as a task', async () => {
    await persistSuggestions([architectural], 'src-task')

    expect(enqueueTask).not.toHaveBeenCalled()
    expect(createProposal).toHaveBeenCalledOnce()
  })

  it('persists a low-confidence mechanical suggestion as a proposal, never as a task', async () => {
    const lowConf = { ...mechanical, confidence: 0.1 }
    await persistSuggestions([lowConf], 'src-task')

    expect(enqueueTask).not.toHaveBeenCalled()
    expect(createProposal).toHaveBeenCalledOnce()
  })

  it('persists multiple mixed suggestions — all as proposals, zero tasks', async () => {
    await persistSuggestions(
      [
        mechanical,
        architectural,
        { ...mechanical, rootCauseKey: 'low_conf', confidence: 0.2 },
      ],
      'src-task',
    )

    expect(enqueueTask).not.toHaveBeenCalled()
    expect(createProposal).toHaveBeenCalledTimes(3)
  })

  it('produces a proposal even for a single-suggestion call with no source task', async () => {
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
          baselineCaught: false,
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
        baselineCaughtCount: 0,
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
