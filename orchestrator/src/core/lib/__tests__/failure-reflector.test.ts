/**
 * Integration tests for spawnFailureReflector.
 *
 * Observable behaviour under test:
 *  1. Claude output is persisted as proposals with source='failure-reflector'
 *  2. Consecutive failures with the same signature trigger one analysis
 *  3. Non-blocking: errors from Claude are swallowed, never thrown
 *
 * runHeadlessProvider is mocked (provider subprocess boundary). Proposals are verified via
 * listProposals from the proposals module (the same PGlite instance the
 * reflector writes to).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// Mock the provider-neutral system boundary (subprocess call).
vi.mock('../../workers/providers', () => ({
  runHeadlessProvider: vi.fn(),
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-failure-reflector-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Craft a minimal RunClaudeResult with controlled suggestion output. */
const makeClaudeResult = (suggestions: unknown[]) => ({
  stdout: JSON.stringify({ suggestions }),
  stderr: '',
  conversation: [] as Array<{ type: string; [k: string]: unknown }>,
  exitCode: 0,
  sessionId: null as string | null,
  quotaRejected: null as { resetsAt: number } | null,
})

const baseOpts = {
  taskId: 'test-task-abc',
  lastStep: 'verify:test-failed',
  lastErrorSignature: 'verify:test-failed:typecheck',
  retryCount: 1,
  worktreePath: null,
  branch: null,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('spawnFailureReflector', () => {
  let repo: string
  let opts = baseOpts

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetAllMocks()
    vi.resetModules()
    const { __resetContextCacheForTests } = await import('../../context')
    const { __resetStateClientForTests } = await import('../../store/state-client')
    __resetContextCacheForTests()
    __resetStateClientForTests()
    opts = {
      ...baseOpts,
      lastErrorSignature: `${baseOpts.lastErrorSignature}:${repo}`,
    }
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FAILURE_REFLECTOR_MAX
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates a proposal when Claude returns a valid suggestion', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider).mockResolvedValueOnce(
      makeClaudeResult([
        {
          recipe: 'add-typecheck',
          title: 'Add TypeScript typecheck gate',
          rationale:
            'Task failed with TS errors that a typecheck gate would have caught earlier.',
          action: 'mars verify add typecheck --cmd npx --args "tsc --noEmit"',
        },
      ]),
    )

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { initProposals, listProposals } = await import('../../proposals')
    await initProposals()

    await spawnFailureReflector(opts)

    const proposals = await listProposals({ source: 'failure-reflector' })
    expect(proposals).toHaveLength(1)
    expect(proposals[0].title).toBe('Add TypeScript typecheck gate')
    expect(proposals[0].source).toBe('failure-reflector')
  })

  it('persists the action as the proposal solution', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider).mockResolvedValueOnce(
      makeClaudeResult([
        {
          recipe: null,
          title: 'Add lint gate to catch style issues early',
          rationale: 'Tasks failed on lint issues repeatedly.',
          action: 'mars verify add lint --cmd npx --args "eslint ."',
        },
      ]),
    )

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { initProposals, listProposals } = await import('../../proposals')
    await initProposals()

    await spawnFailureReflector(opts)

    const proposals = await listProposals({ source: 'failure-reflector' })
    expect(proposals).toHaveLength(1)
    expect(proposals[0].solution).toBe('mars verify add lint --cmd npx --args "eslint ."')
  })

  it('runs one analysis for consecutive failures with the same signature', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider)
      .mockResolvedValueOnce(
        makeClaudeResult([
          {
            recipe: 'add-typecheck',
            title: 'Detect TypeScript errors before merging',
            rationale: 'First observation.',
            action: 'mars verify add typecheck --cmd npx --args "tsc --noEmit"',
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeClaudeResult([
          {
            recipe: 'add-typecheck',
            title: 'Add TypeScript typecheck gate',
            rationale: 'Second observation — same pattern recurred.',
            action: 'mars verify add typecheck --cmd npx --args "tsc --noEmit"',
          },
        ]),
      )

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { initProposals, listProposals } = await import('../../proposals')
    await initProposals()

    for (let i = 0; i < 5; i += 1) {
      await spawnFailureReflector(opts)
    }

    const proposals = await listProposals({ source: 'failure-reflector' })
    expect(proposals).toHaveLength(1)
    expect(runHeadlessProvider).toHaveBeenCalledTimes(1)
  })

  it('keeps a dismissed analysis from being regenerated for the same failure', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider).mockResolvedValue(
      makeClaudeResult([
        {
          recipe: 'add-typecheck',
          title: 'Add TypeScript typecheck gate',
          rationale: 'Would catch type errors before merging.',
          action: 'mars verify add typecheck --cmd npx --args "tsc --noEmit"',
        },
      ]),
    )

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { dismissProposal, initProposals, listProposals } = await import('../../proposals')
    await initProposals()

    await spawnFailureReflector(opts)
    const [created] = await listProposals({ source: 'failure-reflector' })
    await dismissProposal(created.id)
    await spawnFailureReflector(opts)

    expect(await listProposals({ source: 'failure-reflector' })).toHaveLength(1)
    expect(runHeadlessProvider).toHaveBeenCalledTimes(1)
  })

  it('creates one proposal when the same failure is reported concurrently', async () => {
    process.env.MARS_FAILURE_REFLECTOR_MAX = '2'
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider).mockResolvedValue(
      makeClaudeResult([
        {
          recipe: 'add-typecheck',
          title: 'Add TypeScript typecheck gate',
          rationale: 'Would catch type errors before merging.',
          action: 'mars verify add typecheck --cmd npx --args "tsc --noEmit"',
        },
      ]),
    )

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { initProposals, listProposals } = await import('../../proposals')
    await initProposals()

    await Promise.all([spawnFailureReflector(opts), spawnFailureReflector(opts)])

    expect(await listProposals({ source: 'failure-reflector' })).toHaveLength(1)
    expect(runHeadlessProvider).toHaveBeenCalledTimes(1)
  })

  it('creates separate proposals for different failure signatures', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider)
      .mockResolvedValueOnce(
        makeClaudeResult([
          {
            recipe: 'add-typecheck',
            title: 'Add TypeScript typecheck gate',
            rationale: 'Would catch type errors.',
            action: 'mars verify add typecheck --cmd npx --args "tsc --noEmit"',
          },
        ]),
      )
      .mockResolvedValueOnce(
        makeClaudeResult([
          {
            recipe: 'add-unit-tests',
            title: 'Add unit test gate',
            rationale: 'Would catch regressions.',
            action: 'mars verify add test --cmd npm --args "test"',
          },
        ]),
      )

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { initProposals, listProposals } = await import('../../proposals')
    await initProposals()

    await spawnFailureReflector(opts)
    await spawnFailureReflector({
      ...opts,
      lastErrorSignature: 'verify:test-failed:unit-tests',
    })

    const proposals = await listProposals({ source: 'failure-reflector' })
    expect(proposals).toHaveLength(2)
  })

  it('does not throw when Claude errors — fire-and-forget is non-blocking', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider).mockRejectedValueOnce(new Error('provider unavailable'))

    const { spawnFailureReflector } = await import('../failure-reflector')

    // Must resolve (not reject) even when Claude fails
    await expect(spawnFailureReflector(opts)).resolves.toBeUndefined()
  })

  it('does not create any proposals when Claude returns empty suggestions', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider).mockResolvedValueOnce(makeClaudeResult([]))

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { initProposals, listProposals } = await import('../../proposals')
    await initProposals()

    await spawnFailureReflector(opts)

    const proposals = await listProposals({ source: 'failure-reflector' })
    expect(proposals).toHaveLength(0)
  })

  it('does not create proposals for malformed suggestions missing title or action', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider).mockResolvedValueOnce(
      makeClaudeResult([
        { recipe: null, title: '', rationale: 'no title', action: 'do something' },
        { recipe: null, title: 'has title', rationale: 'no action', action: '' },
        { recipe: null /* not even title or action */ },
      ]),
    )

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { initProposals, listProposals } = await import('../../proposals')
    await initProposals()

    await spawnFailureReflector(opts)

    const proposals = await listProposals({ source: 'failure-reflector' })
    expect(proposals).toHaveLength(0)
  })
})
