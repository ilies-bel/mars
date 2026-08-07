/**
 * Tests for the lever-binding requirement on ReflectionSuggestion.
 *
 * Every reflection suggestion must carry an `outcome` that either binds to
 * an existing lever in the registry or declares a lever gap. These tests
 * verify:
 *
 * 1. `parseAndValidateOutcome` rejects unknown lever ids and logs a warning.
 * 2. `parseAndValidateOutcome` rejects out-of-range proposed values and logs.
 * 3. A leverGap outcome with no plausible lever is accepted (gap, not forced
 *    binding) — tested with a real architectural finding fixture.
 * 4. The lever binding is rendered in the proposal notes so
 *    `mars proposal show <id>` gives the operator enough context to act.
 *
 * Strategy: mock at system boundaries (DB, queue, provider) only. Never mock
 * internal reflector logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeverRegistryEntry } from '../lever-registry'

// ─── Module stubs ─────────────────────────────────────────────────────────────

vi.mock('../../proposals', () => ({
  createProposal: vi.fn().mockResolvedValue({ id: 'prop-lever-1' }),
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

vi.mock('../../workers/providers', () => ({ runHeadlessProvider: vi.fn() }))
vi.mock('../../context', () => ({
  getRepoRoot: vi.fn().mockReturnValue('/tmp'),
  resolveContext: vi.fn().mockReturnValue({ stateDir: '/tmp' }),
  resolveDbTarget: vi.fn().mockReturnValue('pglite://reflector-lever-binding'),
}))
vi.mock('../../store/memory-packet-store', () => ({
  insertMemoryPacket: vi.fn().mockResolvedValue({ id: 'mp-1' }),
}))

// ─── Import after mocks ────────────────────────────────────────────────────────

import { parseAndValidateOutcome, persistSuggestions } from '../reflector'
import { loadLeverRegistry } from '../lever-registry'
import { createProposal } from '../../proposals'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal registry subset for validation tests. */
const miniRegistry = (): LeverRegistryEntry[] => [
  {
    id: 'caps.implement',
    label: 'Max implement slots',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => '12',
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars daemon set-cap implement <n>',
    appliesWithoutRestart: true,
  },
  {
    id: 'operator.recovery',
    label: 'Recovery lever',
    family: 'operator',
    scope: 'global',
    readCurrent: () => 'on',
    allowedValues: { type: 'enum', values: ['on', 'off'] },
    gesture: 'mars operator set recovery <on|off>',
    appliesWithoutRestart: true,
  },
]

// ─── parseAndValidateOutcome ───────────────────────────────────────────────────

describe('parseAndValidateOutcome — lever type', () => {
  it('returns a valid lever outcome when id and proposedValue pass', () => {
    const registry = miniRegistry()
    const raw = { type: 'lever', lever: { id: 'caps.implement', currentValue: '12', proposedValue: '8' } }
    const result = parseAndValidateOutcome(raw, registry)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('lever')
    if (result!.type === 'lever') {
      expect(result!.lever.id).toBe('caps.implement')
      expect(result!.lever.proposedValue).toBe('8')
      expect(result!.lever.currentValue).toBe('12')
    }
  })

  it('rejects an unknown lever id and logs a warning', () => {
    const registry = miniRegistry()
    const raw = { type: 'lever', lever: { id: 'nonexistent.lever', proposedValue: 'x' } }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseAndValidateOutcome(raw, registry)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown lever id'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent.lever'))
    warnSpy.mockRestore()
  })

  it('rejects a proposedValue not in enum allowedValues and logs a warning', () => {
    const registry = miniRegistry()
    const raw = { type: 'lever', lever: { id: 'operator.recovery', proposedValue: 'maybe' } }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseAndValidateOutcome(raw, registry)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not in allowedValues'))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('maybe'))
    warnSpy.mockRestore()
  })

  it('rejects a proposedValue below the range minimum and logs a warning', () => {
    const registry = miniRegistry()
    // caps.implement has min: 1
    const raw = { type: 'lever', lever: { id: 'caps.implement', proposedValue: '0' } }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseAndValidateOutcome(raw, registry)
    expect(result).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('out of range'))
    warnSpy.mockRestore()
  })

  it('accepts a valid enum proposedValue', () => {
    const registry = miniRegistry()
    const raw = { type: 'lever', lever: { id: 'operator.recovery', proposedValue: 'off' } }
    const result = parseAndValidateOutcome(raw, registry)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('lever')
  })

  it('accepts a valid range proposedValue', () => {
    const registry = miniRegistry()
    const raw = { type: 'lever', lever: { id: 'caps.implement', proposedValue: '4' } }
    const result = parseAndValidateOutcome(raw, registry)
    expect(result).not.toBeNull()
  })

  it('returns null for missing lever sub-object', () => {
    const registry = miniRegistry()
    const result = parseAndValidateOutcome({ type: 'lever' }, registry)
    expect(result).toBeNull()
  })

  it('returns null for missing proposedValue', () => {
    const registry = miniRegistry()
    const raw = { type: 'lever', lever: { id: 'caps.implement' } }
    const result = parseAndValidateOutcome(raw, registry)
    expect(result).toBeNull()
  })
})

describe('parseAndValidateOutcome — leverGap type', () => {
  it('accepts a leverGap outcome for an architectural finding with no plausible lever', () => {
    // Real architectural finding from the brief: "The slicer distributed a
    // shared contract across seven tasks" — not a knob, must be a gap.
    const registry = miniRegistry()
    const raw = {
      type: 'leverGap',
      leverGap: {
        proposedLeverId: 'slicer.hotspot-overlap-policy',
        family: 'workflow',
        whatItWouldControl: 'how the slicer handles shared contract files across tasks',
      },
    }
    const result = parseAndValidateOutcome(raw, registry)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('leverGap')
    if (result!.type === 'leverGap') {
      expect(result!.leverGap.proposedLeverId).toBe('slicer.hotspot-overlap-policy')
      expect(result!.leverGap.family).toBe('workflow')
      expect(result!.leverGap.whatItWouldControl).toMatch(/shared contract/)
    }
  })

  it('returns null when leverGap sub-fields are missing', () => {
    const registry = miniRegistry()
    expect(parseAndValidateOutcome({ type: 'leverGap', leverGap: { proposedLeverId: 'x' } }, registry)).toBeNull()
    expect(parseAndValidateOutcome({ type: 'leverGap', leverGap: {} }, registry)).toBeNull()
    expect(parseAndValidateOutcome({ type: 'leverGap' }, registry)).toBeNull()
  })
})

describe('parseAndValidateOutcome — invalid type', () => {
  it('returns null for unknown outcome type', () => {
    const registry = miniRegistry()
    expect(parseAndValidateOutcome({ type: 'unknown' }, registry)).toBeNull()
    expect(parseAndValidateOutcome(null, registry)).toBeNull()
    expect(parseAndValidateOutcome(undefined, registry)).toBeNull()
    expect(parseAndValidateOutcome('string', registry)).toBeNull()
  })
})

// ─── Lever binding rendered in proposal ────────────────────────────────────────

describe('persistSuggestions — lever binding rendered in proposal notes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('includes lever id, current→proposed, and gesture in proposal notes for a lever binding', async () => {
    const suggestion = {
      title: 'Lower implement cap to reduce contention',
      prompt: 'Set caps.implement to 8. Expected effect: reduces concurrency contention. Save your work.',
      rationale: null,
      rootCauseKey: 'high_implement_cap',
      affectedTaskIds: [],
      frequency: 1,
      confidence: 0.7,
      kind: 'mechanical' as const,
      outcome: {
        type: 'lever' as const,
        lever: { id: 'caps.implement', currentValue: '12', proposedValue: '8' },
      },
    }
    await persistSuggestions([suggestion], 'src-task')
    expect(createProposal).toHaveBeenCalledOnce()
    const [, opts] = (createProposal as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { notes: string }]
    expect(opts.notes).toMatch(/caps\.implement/)
    expect(opts.notes).toMatch(/→ 8/)
    expect(opts.notes).toMatch(/mars daemon set-cap implement/)
  })

  it('includes gap info in proposal notes for a leverGap outcome', async () => {
    const suggestion = {
      title: 'Slicer needs a hotspot-overlap policy',
      prompt: 'Add a slicer policy for shared contract files. Save your work.',
      rationale: '7 tasks touched the same contract file across a single arc.',
      rootCauseKey: 'slicer_contract_overlap',
      affectedTaskIds: [],
      frequency: 7,
      confidence: 0.85,
      kind: 'architectural' as const,
      outcome: {
        type: 'leverGap' as const,
        leverGap: {
          proposedLeverId: 'slicer.hotspot-overlap-policy',
          family: 'workflow',
          whatItWouldControl: 'how the slicer handles shared contract files across tasks',
        },
      },
    }
    await persistSuggestions([suggestion], 'src-task')
    expect(createProposal).toHaveBeenCalledOnce()
    const [, opts] = (createProposal as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { notes: string }]
    expect(opts.notes).toMatch(/Lever gap/)
    expect(opts.notes).toMatch(/slicer\.hotspot-overlap-policy/)
    expect(opts.notes).toMatch(/workflow/)
    expect(opts.notes).toMatch(/shared contract files/)
  })
})

// ─── Lever list in prompt ─────────────────────────────────────────────────────

describe('buildPrompt — lever registry embedded', () => {
  it('includes lever ids in the built prompt', async () => {
    const { buildPrompt } = await import('../reflector')
    const corpus = {
      entries: [
        {
          taskId: 'fixture-1',
          status: 'done',
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
        taskCount: 0,
        successCount: 0,
        failureCount: 0,
        blockedCount: 0,
        droppedCount: 0,
        cacheHitRatio: 0,
        rateLimitRejections: 0,
        topTokenHeavyTasks: [],
        topExpensiveSteps: [],
        tokensByStep: [],
      },
    }
    const prompt = buildPrompt(corpus as Parameters<typeof buildPrompt>[0])
    // The prompt should contain the lever registry section
    expect(prompt).toMatch(/Lever registry/)
    // At least one known lever id should appear
    expect(prompt).toMatch(/caps\.implement/)
    expect(prompt).toMatch(/operator\.recovery/)
  })

  it('instructs the model to bind each suggestion to a lever or declare a gap', async () => {
    const { buildPrompt } = await import('../reflector')
    const corpus = {
      entries: [{ taskId: 't1', status: 'done', promptPrefix: 'x', errorTail: null, createdAt: '', failureSignature: null, failureReasonCode: null, failedPhase: null, kind: null, fixForTaskId: null, originId: null, toolErrorCount: 0, topErrorTool: null, signals: [], scorerResults: [], totals: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, cacheHitRatio: 0 } }],
      costSummary: { totalWeightedTokens: 0, taskCount: 0, successCount: 0, failureCount: 0, blockedCount: 0, droppedCount: 0, cacheHitRatio: 0, rateLimitRejections: 0, topTokenHeavyTasks: [], topExpensiveSteps: [], tokensByStep: [] },
    }
    const prompt = buildPrompt(corpus as Parameters<typeof buildPrompt>[0])
    const beforeCorpus = prompt.split('Token summary')[0]
    expect(beforeCorpus).toMatch(/LEVER BINDING/)
    expect(beforeCorpus).toMatch(/leverGap/)
    expect(beforeCorpus).toMatch(/BIAS TOWARD GAPS/)
  })
})

// ─── runReflector end-to-end with mocked provider ─────────────────────────────

describe('runReflector — suggestion rejected when outcome invalid', () => {
  it('drops suggestions where lever id is not in registry', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    const { runReflector } = await import('../reflector')

    vi.mocked(runHeadlessProvider).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      conversation: [
        {
          type: 'assistant',
          message: {
            content: JSON.stringify({
              tokenAnalysis: {
                headline: 'ok',
                tokenHeavyTasks: [],
                tokenHeavySteps: [],
                cacheHealth: null,
                successVsFailureTokens: null,
                notes: '',
              },
              suggestions: [
                {
                  title: 'Bad suggestion',
                  prompt: 'Do something. Save your work.',
                  rootCauseKey: 'bad_lever_id',
                  affectedTaskIds: [],
                  frequency: 1,
                  confidence: 0.8,
                  kind: 'mechanical',
                  outcome: {
                    type: 'lever',
                    lever: { id: 'nonexistent.lever', currentValue: null, proposedValue: 'x' },
                  },
                },
              ],
            }),
          },
        },
      ],
    } as never)

    const corpus = {
      entries: [{ taskId: 't1', status: 'done', promptPrefix: 'x', errorTail: null, createdAt: '', failureSignature: null, failureReasonCode: null, failedPhase: null, kind: null, fixForTaskId: null, originId: null, toolErrorCount: 0, topErrorTool: null, signals: [], scorerResults: [], totals: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, cacheHitRatio: 0 } }],
      costSummary: { totalWeightedTokens: 0, taskCount: 0, successCount: 0, failureCount: 0, blockedCount: 0, droppedCount: 0, cacheHitRatio: 0, rateLimitRejections: 0, topTokenHeavyTasks: [], topExpensiveSteps: [], tokensByStep: [] },
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await runReflector(corpus as Parameters<typeof runReflector>[0])
    expect(result.suggestions).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown lever id'))
    warnSpy.mockRestore()
  })

  it('accepts a leverGap suggestion from a provider response', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    const { runReflector } = await import('../reflector')

    vi.mocked(runHeadlessProvider).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      conversation: [
        {
          type: 'assistant',
          message: {
            content: JSON.stringify({
              tokenAnalysis: {
                headline: 'ok',
                tokenHeavyTasks: [],
                tokenHeavySteps: [],
                cacheHealth: null,
                successVsFailureTokens: null,
                notes: '',
              },
              suggestions: [
                {
                  title: 'Add slicer overlap policy',
                  prompt: 'Add a slicer policy. Save your work.',
                  rootCauseKey: 'slicer_overlap',
                  affectedTaskIds: [],
                  frequency: 3,
                  confidence: 0.75,
                  kind: 'architectural',
                  outcome: {
                    type: 'leverGap',
                    leverGap: {
                      proposedLeverId: 'slicer.hotspot-overlap-policy',
                      family: 'workflow',
                      whatItWouldControl: 'how the slicer handles shared files',
                    },
                  },
                },
              ],
            }),
          },
        },
      ],
    } as never)

    const corpus = {
      entries: [{ taskId: 't1', status: 'done', promptPrefix: 'x', errorTail: null, createdAt: '', failureSignature: null, failureReasonCode: null, failedPhase: null, kind: null, fixForTaskId: null, originId: null, toolErrorCount: 0, topErrorTool: null, signals: [], scorerResults: [], totals: { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0, cacheHitRatio: 0 } }],
      costSummary: { totalWeightedTokens: 0, taskCount: 0, successCount: 0, failureCount: 0, blockedCount: 0, droppedCount: 0, cacheHitRatio: 0, rateLimitRejections: 0, topTokenHeavyTasks: [], topExpensiveSteps: [], tokensByStep: [] },
    }

    const result = await runReflector(corpus as Parameters<typeof runReflector>[0])
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0].outcome.type).toBe('leverGap')
    expect(result.suggestions[0].title).toBe('Add slicer overlap policy')
  })
})
