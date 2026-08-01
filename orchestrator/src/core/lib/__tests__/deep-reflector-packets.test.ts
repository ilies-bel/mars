/**
 * Unit tests for the memory-packet emission added to runDeepReflectorArc
 * (PRD 6544c0a0, slice 5).
 *
 * The reflector provider runner is stubbed at the system boundary.
 * insertMemoryPacket (DB write) and getTask (DB read) are also stubbed.
 *
 * Observable behaviour under test:
 * - exactly two packets land for a report with 2 save-verdict + 1 skip
 * - each packet carries the correct domain and originArcId
 * - no packets land when MARS_REFLECT_DISABLED=1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DeepReflectArc } from '../deep-reflect-query'

// ── module mocks (hoisted by Vitest before imports) ───────────────────────────

vi.mock('../../workers/providers', () => ({
  runHeadlessProvider: vi.fn(),
}))

vi.mock('../../store/memory-packet-store', () => ({
  insertMemoryPacket: vi.fn().mockResolvedValue({ id: 'mp-test-00' }),
  initMemoryPackets: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../queue', () => ({
  getTask: vi.fn(),
  migrateQueueSchema: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../context', () => ({
  getRepoRoot: vi.fn().mockReturnValue('/tmp/mars-unit-test-repo'),
  resolveContext: vi.fn().mockReturnValue({
    repoRoot: '/tmp/mars-unit-test-repo',
    stateDir: '/tmp/mars-unit-test-repo/.mars',
    queueDbPath: '/tmp/mars-unit-test-repo/.mars/mars.db',
  }),
}))

// ── shared fixtures ───────────────────────────────────────────────────────────

/**
 * A fake report JSON with 2 save-verdict suggestions and 1 drop-verdict one.
 * The parser in deep-reflector.ts will extract this from r.stdout.
 */
const FAKE_REPORT_WITH_TWO_SAVES = JSON.stringify({
  summary: 'test arc reflection',
  toolCallStats: { total: 5, byName: { Edit: 3, Bash: 2 } },
  dissonantCalls: [],
  verifyMismatches: [],
  thrashingPatterns: [],
  rootCause: 'test root cause',
  suggestions: [
    {
      title: 'Save lesson A',
      prompt: 'Fix issue A in src/foo.ts. Save your work.',
      rationale: 'high impact',
      verdict: 'save',
      confidence: 0.9,
      target_id: null,
      dup_of: null,
    },
    {
      title: 'Save lesson B',
      prompt: 'Improve error handling in src/bar.ts. Save your work.',
      rationale: 'medium impact',
      verdict: 'save',
      confidence: 0.8,
      target_id: null,
      dup_of: null,
    },
    {
      title: 'Skip lesson',
      prompt: 'Minor nit. Save your work.',
      rationale: 'unimportant',
      verdict: 'drop',
      confidence: 0.2,
      target_id: null,
      dup_of: null,
    },
  ],
  scorerSuggestions: [],
  capabilityGapSuggestions: [],
})

/** Minimal arc whose originId matches the task we stub via getTask. */
const makeMinimalArc = (): DeepReflectArc => ({
  originId: 'test-origin-abc',
  taskCount: 1,
  statusMix: { done: 1 },
  totals: {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalWeightedTokens: 105,
    cacheHitRatio: 0,
    eventCount: 5,
  },
  lastActivity: new Date().toISOString(),
  tasks: [],
  stepTimeline: [],
  toolInvokedErrors: [],
  operatorContext: null,
})

// ── shared setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.MARS_REFLECT_DISABLED
})

// ── helper: wire stubs so the happy path runs end-to-end ──────────────────────

const wireHappyPath = async (opts: { workflow?: string; tags?: string[] } = {}) => {
  const { runHeadlessProvider } = await import('../../workers/providers')
  const { insertMemoryPacket } = await import('../../store/memory-packet-store')
  const { getTask } = await import('../../queue')

  vi.mocked(runHeadlessProvider).mockResolvedValue({
    exitCode: 0,
    stdout: FAKE_REPORT_WITH_TWO_SAVES,
    conversation: [],
  } as never)

  vi.mocked(insertMemoryPacket).mockResolvedValue({ id: 'mp-test-00' } as never)

  vi.mocked(getTask).mockResolvedValue({
    id: 'test-origin-abc',
    workflow: opts.workflow ?? 'implement',
    tags: opts.tags ?? [],
    status: 'done',
    prompt: 'test task',
    kind: 'task',
    fixForTaskId: null,
    originId: 'test-origin-abc',
    priority: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergeMode: 'auto',
    plan: null,
    error: null,
    branch: null,
    worktreePath: null,
    leaseOwner: null,
    leasedAt: null,
    leaseNote: null,
    retries: 0,
    doneFiles: null,
    verifyCmd: null,
    sessionIds: [],
    signals: [],
    scorerResults: [],
  } as never)

  return { runHeadlessProvider, insertMemoryPacket, getTask }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('runDeepReflectorArc — memory packet emission', () => {
  it('inserts exactly two packets for a report with 2 save + 1 drop', async () => {
    const { insertMemoryPacket } = await wireHappyPath()
    const { runDeepReflectorArc } = await import('../deep-reflector')

    await runDeepReflectorArc(makeMinimalArc())

    expect(vi.mocked(insertMemoryPacket)).toHaveBeenCalledTimes(2)
  })

  it('uses the origin task workflow as the domain', async () => {
    const { insertMemoryPacket } = await wireHappyPath({ workflow: 'implement' })
    const { runDeepReflectorArc } = await import('../deep-reflector')

    await runDeepReflectorArc(makeMinimalArc())

    const calls = vi.mocked(insertMemoryPacket).mock.calls
    expect(calls).toHaveLength(2)
    for (const [args] of calls) {
      expect(args.domain).toBe('implement')
    }
  })

  it('uses the first tag when workflow is null', async () => {
    const { getTask, insertMemoryPacket } = await wireHappyPath()
    const { runDeepReflectorArc } = await import('../deep-reflector')

    vi.mocked(getTask).mockResolvedValue({
      workflow: null,
      tags: ['coder'],
    } as never)

    await runDeepReflectorArc(makeMinimalArc())

    const calls = vi.mocked(insertMemoryPacket).mock.calls
    expect(calls).toHaveLength(2)
    for (const [args] of calls) {
      expect(args.domain).toBe('coder')
    }
  })

  it("falls back to 'general' when workflow is null and tags are empty", async () => {
    const { getTask, insertMemoryPacket } = await wireHappyPath()
    const { runDeepReflectorArc } = await import('../deep-reflector')

    vi.mocked(getTask).mockResolvedValue({
      workflow: null,
      tags: [],
    } as never)

    await runDeepReflectorArc(makeMinimalArc())

    const calls = vi.mocked(insertMemoryPacket).mock.calls
    for (const [args] of calls) {
      expect(args.domain).toBe('general')
    }
  })

  it('sets originArcId to the arc originId on every inserted packet', async () => {
    const { insertMemoryPacket } = await wireHappyPath()
    const { runDeepReflectorArc } = await import('../deep-reflector')

    const arc = makeMinimalArc()
    await runDeepReflectorArc(arc)

    const calls = vi.mocked(insertMemoryPacket).mock.calls
    expect(calls).toHaveLength(2)
    for (const [args] of calls) {
      expect(args.originArcId).toBe(arc.originId)
    }
  })

  it('does not insert packets when MARS_REFLECT_DISABLED=1', async () => {
    process.env.MARS_REFLECT_DISABLED = '1'

    const { insertMemoryPacket } = await wireHappyPath()
    const { runDeepReflectorArc } = await import('../deep-reflector')

    await runDeepReflectorArc(makeMinimalArc())

    expect(vi.mocked(insertMemoryPacket)).not.toHaveBeenCalled()
  })

  it('does not insert packets when the reflector exits non-zero', async () => {
    const { runHeadlessProvider, insertMemoryPacket } = await wireHappyPath()
    const { runDeepReflectorArc } = await import('../deep-reflector')

    vi.mocked(runHeadlessProvider).mockResolvedValue({
      exitCode: 1,
      stdout: FAKE_REPORT_WITH_TWO_SAVES,
      conversation: [],
    } as never)

    await runDeepReflectorArc(makeMinimalArc())

    expect(vi.mocked(insertMemoryPacket)).not.toHaveBeenCalled()
  })
})
