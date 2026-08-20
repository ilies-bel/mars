/**
 * Verifies the least-specific-valid-rule clause (ADR 0099) is present in the
 * failure-reflector's system prompt *as actually sent* — i.e. after
 * SYSTEM_PROMPT_TEMPLATE's `{catalog}`/`{arcContext}` placeholders are
 * substituted, not merely present in the source template string. A clause
 * that gets clobbered by a bad `.replace()` (e.g. a second `{catalog}`
 * occurrence, or an arcContext value containing `{catalog}` literally) would
 * still pass a source-string assertion but silently vanish from the prompt
 * the provider receives.
 *
 * runHeadlessProvider is mocked (provider subprocess boundary) so we can
 * capture the exact prompt string spawnFailureReflector constructs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

vi.mock('../../workers/providers', () => ({
  runHeadlessProvider: vi.fn(),
}))

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-failure-reflector-weakest-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const makeClaudeResult = (suggestions: unknown[]) => ({
  stdout: JSON.stringify({ suggestions }),
  stderr: '',
  conversation: [] as Array<{ type: string; [k: string]: unknown }>,
  exitCode: 0,
  sessionId: null as string | null,
  quotaRejected: null as { resetsAt: number } | null,
})

describe('spawnFailureReflector — least-specific-valid-rule clause', () => {
  let repo: string
  let opts: {
    taskId: string
    lastStep: string
    lastErrorSignature: string
    recoverySpawnedCount: number
    worktreePath: string | null
    branch: string | null
  }

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
      taskId: 'test-task-weakest',
      lastStep: 'verify:test-failed',
      lastErrorSignature: `verify:test-failed:typecheck:${repo}`,
      recoverySpawnedCount: 1,
      worktreePath: null,
      branch: null,
    }
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FAILURE_REFLECTOR_MAX
    rmSync(repo, { recursive: true, force: true })
  })

  it('sends the least-specific-valid-rule clause in the prompt actually passed to the provider', async () => {
    const { runHeadlessProvider } = await import('../../workers/providers')
    vi.mocked(runHeadlessProvider).mockResolvedValueOnce(makeClaudeResult([]))

    const { spawnFailureReflector } = await import('../failure-reflector')
    const { initProposals } = await import('../../proposals')
    await initProposals()

    await spawnFailureReflector(opts)

    expect(runHeadlessProvider).toHaveBeenCalledTimes(1)
    const [sentPrompt] = vi.mocked(runHeadlessProvider).mock.calls[0]

    // The clause must require validity on cited evidence...
    expect(sentPrompt).toMatch(/valid on every failure instance you cite as\s+evidence/i)
    // ...and no more specific than that evidence requires (the weakest-valid-hypothesis half).
    expect(sentPrompt).toMatch(/no\s+MORE SPECIFIC than that evidence requires/i)
    // The model must name what the advice covers...
    expect(sentPrompt).toMatch(/which\s+failures\/instances this rule COVERS/i)
    // ...and what it does not claim.
    expect(sentPrompt).toMatch(/what it does\s+NOT claim to cover/i)

    // Placeholders must still be substituted — the clause must not have
    // been introduced by breaking the {catalog}/{arcContext} substitution.
    expect(sentPrompt).not.toContain('{catalog}')
    expect(sentPrompt).not.toContain('{arcContext}')
    expect(sentPrompt).toContain(`Task ID: ${opts.taskId}`)
  })
})
