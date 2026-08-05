import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'

const {
  mockUpdateTask,
  mockVerifyChanges,
  mockGetChangedFiles,
  mockLoadVerifyGates,
  mockAppendEnrichmentScopes,
  mockRecordEnrichmentShadowRuns,
} = vi.hoisted(() => ({
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockVerifyChanges: vi.fn(),
  mockGetChangedFiles: vi.fn(),
  mockLoadVerifyGates: vi.fn(),
  mockAppendEnrichmentScopes: vi.fn(),
  mockRecordEnrichmentShadowRuns: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../core/queue', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/queue')>()
  return { ...original, updateTask: mockUpdateTask }
})

vi.mock('../../../core/lib/git/verify', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/lib/git/verify')>()
  return {
    ...original,
    getChangedFiles: mockGetChangedFiles,
    verifyChanges: mockVerifyChanges,
  }
})

vi.mock('../../../core/lib/gate-enrichment', () => ({
  appendEnrichmentScopes: mockAppendEnrichmentScopes,
  recordEnrichmentShadowRuns: mockRecordEnrichmentShadowRuns,
}))

vi.mock('../../../core/verify-gates', () => ({
  loadVerifyGates: mockLoadVerifyGates,
}))

const { review } = await import('../index')

let repoRoot: string

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'mars-verify-coverage-'))
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

beforeEach(() => {
  process.env.MARS_REPO = repoRoot
  __resetContextCacheForTests()
  mockUpdateTask.mockClear().mockResolvedValue(undefined)
  mockGetChangedFiles.mockReset().mockResolvedValue(['apps/web/App.tsx'])
  mockVerifyChanges.mockReset().mockResolvedValue({
    passed: true,
    verdict: 'PASS',
    steps: [],
  })
  mockLoadVerifyGates.mockReset().mockResolvedValue([
    {
      scope: '.',
      steps: [{ gateId: 'root-gate', name: 'root-lint', cmd: 'node', args: ['-e', ''], required: true }],
    },
    {
      scope: 'apps/web',
      steps: [{ gateId: 'web-gate', name: 'web-test', cmd: 'node', args: ['-e', ''], required: true }],
    },
    {
      scope: 'services/api',
      steps: [{ gateId: 'api-gate', name: 'api-test', cmd: 'node', args: ['-e', ''], required: true }],
    },
  ])
  mockAppendEnrichmentScopes
    .mockReset()
    .mockImplementation((_store: unknown, scopes: unknown[]) => Promise.resolve(scopes))
  mockRecordEnrichmentShadowRuns.mockClear().mockResolvedValue(undefined)
})

const makeCtx = (taskId: string) =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'fix' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
      },
      traceStore: null,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  }) as never

describe('review verify coverage', () => {
  it('computes changed files before selecting root and path-covered task gates', async () => {
    const taskId = 'mars-coverage01'
    const worktreePath = mkdtempSync(join(tmpdir(), 'mars-coverage-worktree-'))

    await expect(
      review(makeCtx(taskId), {
        kind: 'fix',
        worktree: { path: worktreePath, branch: `task/${taskId}` },
      }),
    ).resolves.toEqual({ verified: true })

    expect(mockGetChangedFiles).toHaveBeenCalledWith(
      worktreePath,
      'main',
      `task/${taskId}`,
      expect.anything(),
    )
    expect(mockVerifyChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: ['apps/web/App.tsx'],
        steps: [
          expect.objectContaining({ gateId: 'root-gate', name: 'root-lint', dir: '.' }),
          expect.objectContaining({ gateId: 'web-gate', name: 'web-test', dir: 'apps/web' }),
        ],
      }),
    )
  })
})
