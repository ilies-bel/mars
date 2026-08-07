import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DeepReflectArc } from '../deep-reflect-query'

vi.mock('../../workers/providers', () => ({
  runHeadlessProvider: vi.fn(),
  usageSemanticsOf: vi.fn().mockReturnValue('none' as const),
}))

vi.mock('../../store/memory-packet-store', () => ({
  insertMemoryPacket: vi.fn().mockResolvedValue({ id: 'packet-1' }),
}))

vi.mock('../../proposals', () => ({
  createProposal: vi.fn().mockResolvedValue({ id: 'proposal-1' }),
  findOpenReflectionDraftByFingerprint: vi.fn().mockResolvedValue(null),
  appendProposalNotes: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../queue', () => ({
  enqueueTask: vi.fn(),
  getTask: vi.fn().mockResolvedValue({ workflow: 'implement', tags: [] }),
}))

let repo: string

const arc: DeepReflectArc = {
  originId: 'origin-auto-reflect',
  taskCount: 1,
  statusMix: { done: 1 },
  totals: {
    inputTokens: 1,
    outputTokens: 1,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalWeightedTokens: 2,
    cacheHitRatio: 1,
    eventCount: 1,
  },
  lastActivity: '2026-01-01T00:00:00.000Z',
  tasks: [],
  stepTimeline: [],
  toolInvokedErrors: [],
  operatorContext: null,
}

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-auto-reflect-gate-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  writeFileSync(
    resolve(repo, '.mars', 'daemon.json'),
    JSON.stringify({ controlLevers: { autoReflect: 'off' } }),
  )
  process.env.MARS_REPO = repo
  delete process.env.MARS_REFLECT_DISABLED
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_REFLECT_DISABLED
  rmSync(repo, { recursive: true, force: true })
})

describe('auto-reflect gate', () => {
  it('reads autoReflect: off from daemon.json', async () => {
    const { isMemoryCaptureDisabled } = await import('../auto-reflect-gate')

    expect(isMemoryCaptureDisabled()).toBe(true)
  })

  it('skips automatic reflection persistence while preserving task signal capture', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    const { insertMemoryPacket } = await import('../../store/memory-packet-store')
    const { persistSuggestions } = await import('../reflector')
    const { runDeepReflectorArc } = await import('../deep-reflector')
    const { recordSignals } = await import('../reflect-signals')
    const { runWorkerWithSpan } = await import('../run-worker-with-span')

    vi.mocked(runHeadlessProvider).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        summary: 'report',
        toolCallStats: { total: 0, byName: {} },
        dissonantCalls: [],
        verifyMismatches: [],
        thrashingPatterns: [],
        rootCause: '',
        suggestions: [
          { title: 'Save', prompt: 'Save this lesson.', verdict: 'save', confidence: 0.8 },
        ],
        scorerSuggestions: [],
        capabilityGapSuggestions: [],
      }),
      conversation: [],
    } as never)

    await persistSuggestions(
      [
        {
          title: 'Save a lesson',
          prompt: 'Save this lesson.',
          rationale: null,
          rootCauseKey: 'auto_reflect_test',
          affectedTaskIds: [],
          frequency: 1,
          confidence: 0.8,
          kind: 'mechanical',
          outcome: {
            type: 'leverGap' as const,
            leverGap: { proposedLeverId: 'test.auto-reflect', family: 'operator', whatItWouldControl: 'auto-reflect test lever' },
          },
        },
      ],
      'source-task',
    )
    await runDeepReflectorArc(arc)

    // The lever does not disable an operator's explicit reflection command.
    expect(vi.mocked(runHeadlessProvider)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(insertMemoryPacket)).not.toHaveBeenCalled()

    await recordSignals('task-1', 'run-claude-code', {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      messageCount: 1,
    })

    const appendDurableTranscript = vi.fn().mockResolvedValue(undefined)
    await runWorkerWithSpan({
      worker: {
        config: { name: 'Coder', provider: 'claude' },
        run: async () => ({
          exitCode: 0,
          stdout: '',
          stderr: '',
          sessionId: null,
          conversation: [],
          quotaRejected: null,
        }),
      } as never,
      prompt: 'capture this task',
      runOptions: { cwd: repo },
      traceStore: {
        record: async () => {},
        appendDurableTranscript,
      } as never,
      stepName: 'run-claude-code',
      workflowInstanceId: 'workflow-1',
      originId: 'origin-1',
      taskId: 'task-1',
    })

    expect(appendDurableTranscript).toHaveBeenCalledWith(
      'task-1',
      '',
      'run-claude-code',
      '[]',
    )
  })
})
