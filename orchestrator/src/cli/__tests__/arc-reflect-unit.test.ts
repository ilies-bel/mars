/**
 * Unit tests for `mars arc reflect` with a stubbed deep-reflector.
 *
 * These tests drive the command in-process through the Command seam
 * (ADR-0023) — no binary spawned, no process.exit.
 *
 * Key invariant under test: when `runDeepReflectorArc` exits non-zero,
 * the command must:
 *   1. Return a non-zero exit code.
 *   2. NOT call `applyVerdicts` or `insertReflectionTask`.
 *   3. Write a JSON report stamped with `status: 'partial'` and
 *      `reflectorExitCode` so a later reader cannot mistake it for a
 *      complete analysis.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'
import type { DeepReflectArc } from '../../core/lib/deep-reflect-query'

// ─── module mocks (hoisted by Vitest before any imports) ──────────────────────

vi.mock('../../core/lib/deep-reflector', () => ({
  runDeepReflectorArc: vi.fn(),
}))

vi.mock('../../core/lib/deep-reflect-query', () => ({
  loadDeepReflectArc: vi.fn(),
  resolveOriginIdForTaskOrSelf: vi.fn(),
  listDeepReflectArcCandidates: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../core/lib/reflector', () => ({
  applyVerdicts: vi.fn(),
  applyScorerVerdicts: vi.fn(),
  applyCapabilityGapVerdicts: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('../../core/context', () => ({
  getStateDir: vi.fn().mockReturnValue('/tmp/mars-unit-test-state'),
}))

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal arc that satisfies every field the command reads before/after calling runDeepReflectorArc. */
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
    eventCount: 10,
  },
  lastActivity: new Date().toISOString(),
  tasks: [],
  stepTimeline: [],
  toolInvokedErrors: [],
  operatorContext: null,
})

/** Minimal empty report (mirrors emptyReport() in deep-reflector.ts). */
const makeEmptyReport = () =>
  ({
    summary: '',
    toolCallStats: { total: 0, byName: {} },
    dissonantCalls: [],
    verifyMismatch: null,
    verifyMismatches: [],
    thrashingPatterns: [],
    rootCause: '',
    suggestions: [],
  }) as const

/** Fake store — only `insertReflectionTask` matters for these tests. */
const makeFakeStore = () =>
  ({
    insertReflectionTask: vi.fn().mockResolvedValue('fake-source-task-id'),
  }) as unknown as DomainTaskStore

/** Minimal context — not read directly by arcReflect (getStateDir is mocked). */
const fakeCtx: OrchestratorContext = {
  repoRoot: '/tmp/mars-unit-repo',
  stateDir: '/tmp/mars-unit-repo/.mars',
  queueDbPath: '/tmp/mars-unit-repo/.mars/mars.db',
  observabilityDbPath: '/tmp/mars-unit-repo/.mars/observability.db',
  stateDbPath: '/tmp/mars-unit-repo/.mars/state.db',
}

// ─── shared setup ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks()
  // Re-apply default resolutions so stubs don't return undefined on await
  const { mkdir, writeFile } = await import('node:fs/promises')
  vi.mocked(mkdir).mockResolvedValue(undefined)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  // listDeepReflectArcCandidates must keep returning [] (used in interactive picker path)
  const { listDeepReflectArcCandidates } = await import('../../core/lib/deep-reflect-query')
  vi.mocked(listDeepReflectArcCandidates).mockResolvedValue([])
})

// ─── shared stub wiring ───────────────────────────────────────────────────────

/** Wire all stubs so the reflector path is reached, then return exitCode 124. */
const wireReflectorTimeout = async () => {
  const { runDeepReflectorArc } = await import('../../core/lib/deep-reflector')
  const { loadDeepReflectArc, resolveOriginIdForTaskOrSelf } = await import(
    '../../core/lib/deep-reflect-query'
  )
  vi.mocked(resolveOriginIdForTaskOrSelf).mockResolvedValue('test-origin-abc')
  vi.mocked(loadDeepReflectArc).mockResolvedValue(makeMinimalArc())
  vi.mocked(runDeepReflectorArc).mockResolvedValue({
    exitCode: 124,
    report: makeEmptyReport() as never,
    rawOutput: '',
  })
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('mars arc reflect — reflector exits non-zero (exit 124 / timeout)', () => {
  it('returns non-zero command exit code when the reflector exits 124', async () => {
    await wireReflectorTimeout()

    const r = await runCommandInProcess(['arc', 'reflect', 'test-origin-abc'], {
      store: makeFakeStore(),
      ctx: fakeCtx,
      daemon: makeFakeDaemon(),
    })

    expect(r.code).not.toBe(0)
  })

  it('does not call applyVerdicts when the reflector exits 124', async () => {
    await wireReflectorTimeout()
    const { applyVerdicts } = await import('../../core/lib/reflector')

    const store = makeFakeStore()
    await runCommandInProcess(['arc', 'reflect', 'test-origin-abc'], {
      store,
      ctx: fakeCtx,
      daemon: makeFakeDaemon(),
    })

    expect(vi.mocked(applyVerdicts)).not.toHaveBeenCalled()
  })

  it('does not call insertReflectionTask when the reflector exits 124', async () => {
    await wireReflectorTimeout()

    const store = makeFakeStore()
    await runCommandInProcess(['arc', 'reflect', 'test-origin-abc'], {
      store,
      ctx: fakeCtx,
      daemon: makeFakeDaemon(),
    })

    expect(vi.mocked(store.insertReflectionTask)).not.toHaveBeenCalled()
  })

  it('writes JSON report with status=partial and reflectorExitCode=124', async () => {
    await wireReflectorTimeout()
    const { writeFile } = await import('node:fs/promises')

    await runCommandInProcess(['arc', 'reflect', 'test-origin-abc'], {
      store: makeFakeStore(),
      ctx: fakeCtx,
      daemon: makeFakeDaemon(),
    })

    const writeCalls = vi.mocked(writeFile).mock.calls
    expect(writeCalls.length).toBeGreaterThan(0)
    const [, rawContent] = writeCalls[0]
    const doc = JSON.parse(rawContent as string) as Record<string, unknown>

    expect(doc['status']).toBe('partial')
    expect(doc['reflectorExitCode']).toBe(124)
  })

  it('emits a failure banner to stderr mentioning the exit code', async () => {
    await wireReflectorTimeout()

    const r = await runCommandInProcess(['arc', 'reflect', 'test-origin-abc'], {
      store: makeFakeStore(),
      ctx: fakeCtx,
      daemon: makeFakeDaemon(),
    })

    const stderrText = r.err.join('\n')
    expect(stderrText).toContain('124')
    expect(stderrText).toMatch(/fail|partial|unusable/i)
  })

  it('does not print the Tool calls / Dissonant calls stats block on failure', async () => {
    await wireReflectorTimeout()

    const r = await runCommandInProcess(['arc', 'reflect', 'test-origin-abc'], {
      store: makeFakeStore(),
      ctx: fakeCtx,
      daemon: makeFakeDaemon(),
    })

    const stdoutText = r.out.join('\n')
    expect(stdoutText).not.toContain('Tool calls:')
    expect(stdoutText).not.toContain('Dissonant calls:')
    expect(stdoutText).not.toContain('Suggestions:')
  })
})
