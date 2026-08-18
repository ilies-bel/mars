import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { FailedPhase, Task, TaskSpec } from '../queue.js'

// vi.mock is hoisted before imports — factory may only use vitest globals
vi.mock('../queue.js', () => ({
  resolveQueueClient: vi.fn(),
  getTranscript: vi.fn(),
}))

import * as Q from '../queue.js'
import { composeRestartCheckpoint } from './restart-checkpoint.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function setupRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-rcp-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir })
  // Task worktrees branch off main; create a task branch so merge-base works.
  execFileSync('git', ['checkout', '-b', 'task/test-01'], { cwd: dir })
  return dir
}

function addCommit(dir: string, files: Record<string, string>, message: string): void {
  for (const [name, content] of Object.entries(files)) {
    const abs = resolve(dir, name)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-m', message], { cwd: dir })
}

function makeSpec(partial: Partial<TaskSpec> = {}): TaskSpec {
  return { files: [], verifyCmd: null, doneCriteria: [], mergeMode: 'auto', ...partial } as TaskSpec
}

function makeTask(partial: {
  failedPhase?: FailedPhase | null
  failureReasonCode?: string | null
  failureSignature?: string | null
  stallDiagnostics?: string | null
  spec?: TaskSpec | null
} = {}): Task {
  return {
    failedPhase: partial.failedPhase ?? null,
    failureReasonCode: partial.failureReasonCode ?? null,
    failureSignature: partial.failureSignature ?? null,
    stallDiagnostics: partial.stallDiagnostics ?? null,
    spec: partial.spec ?? null,
  } as unknown as Task
}

// A stable mock execute function re-created in each beforeEach
let mockExec: ReturnType<typeof vi.fn>
let repoDir: string

beforeEach(() => {
  repoDir = setupRepo()
  mockExec = vi.fn().mockResolvedValue({ rows: [] })
  vi.mocked(Q.resolveQueueClient).mockReturnValue({ execute: mockExec } as any)
  vi.mocked(Q.getTranscript).mockResolvedValue(null)
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
  vi.resetAllMocks()
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('composeRestartCheckpoint', () => {
  // ── commits: zero ──────────────────────────────────────────────────────

  describe('zero commits', () => {
    it('returns empty commits and changedPaths when no commits ahead of main', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask(),
      })
      expect(result.commits).toEqual([])
      expect(result.changedPaths).toEqual([])
    })
  })

  // ── commits: N commits with overlapping paths ─────────────────────────

  describe('N commits with overlapping paths', () => {
    it('collects each commit with its files and deduplicates changedPaths', async () => {
      addCommit(repoDir, { 'src/a.ts': 'a', 'src/b.ts': 'b' }, 'add a and b')
      addCommit(repoDir, { 'src/a.ts': 'a2', 'src/c.ts': 'c' }, 'modify a and add c')

      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask(),
      })

      // git log --format shows newest-first
      expect(result.commits).toHaveLength(2)
      expect(result.commits[0]!.subject).toBe('modify a and add c')
      expect(result.commits[0]!.files).toEqual(['src/a.ts', 'src/c.ts'])
      expect(result.commits[1]!.subject).toBe('add a and b')
      expect(result.commits[1]!.files).toEqual(['src/a.ts', 'src/b.ts'])

      // a.ts appears in both commits but is listed once in changedPaths
      expect(result.changedPaths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    })

    it('includes a 40-character hex sha for each commit', async () => {
      addCommit(repoDir, { 'x.ts': '1' }, 'one')
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask(),
      })
      expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
    })
  })

  // ── outstandingCriteria: no criteria ──────────────────────────────────

  describe('no criteria at all', () => {
    it('returns empty array when task has no spec', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({ spec: null }),
      })
      expect(result.outstandingCriteria).toEqual([])
    })

    it('returns empty array when spec has empty doneCriteria', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({ spec: makeSpec({ doneCriteria: [] }) }),
      })
      expect(result.outstandingCriteria).toEqual([])
    })
  })

  // ── outstandingCriteria: all checked ─────────────────────────────────

  describe('all criteria checked', () => {
    it('returns empty array when every criterion has status met', async () => {
      mockExec.mockResolvedValue({
        rows: [
          { text: 'criterion A', status: 'met' },
          { text: 'criterion B', status: 'met' },
        ],
      })

      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({
          spec: makeSpec({ doneCriteria: ['criterion A', 'criterion B'] }),
        }),
      })

      expect(result.outstandingCriteria).toEqual([])
    })

    it('returns unmet criteria when some are still pending', async () => {
      mockExec.mockResolvedValue({
        rows: [
          { text: 'criterion A', status: 'met' },
          { text: 'criterion B', status: 'pending' },
        ],
      })

      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({
          spec: makeSpec({ doneCriteria: ['criterion A', 'criterion B'] }),
        }),
      })

      expect(result.outstandingCriteria).toEqual(['criterion B'])
    })

    it('returns all criteria when no acceptance rows exist yet', async () => {
      // mockExec default returns { rows: [] }
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({
          spec: makeSpec({ doneCriteria: ['do A', 'do B'] }),
        }),
      })

      expect(result.outstandingCriteria).toEqual(['do A', 'do B'])
    })
  })

  // ── lastVerify: absent ────────────────────────────────────────────────

  describe('prior verify failure absent', () => {
    it('returns null when failedPhase is null', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({ failedPhase: null }),
      })
      expect(result.lastVerify).toBeNull()
    })

    it('returns null when failedPhase is code', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({ failedPhase: 'code' }),
      })
      expect(result.lastVerify).toBeNull()
    })
  })

  // ── lastVerify: present ───────────────────────────────────────────────

  describe('prior verify failure present', () => {
    it('returns a LastVerify object with command and signature', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({
          failedPhase: 'verify',
          failureReasonCode: 'verify:typecheck',
          spec: makeSpec({ verifyCmd: 'npm run typecheck' }),
        }),
      })

      expect(result.lastVerify).not.toBeNull()
      expect(result.lastVerify!.command).toBe('npm run typecheck')
      expect(result.lastVerify!.signature).toBe('verify:typecheck')
      expect(result.lastVerify!.exitCode).toBeNull()
      expect(result.lastVerify!.tailOutput).toBeNull()
    })

    it('populates tailOutput from transcript verifyOutput', async () => {
      vi.mocked(Q.getTranscript).mockResolvedValue({
        taskId: 'task-01',
        conversationJson: '',
        verifyOutput: 'error: type mismatch\n  at line 42',
        bytes: 35,
        recordedAt: '2026-08-17T00:00:00.000Z',
      })

      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({ failedPhase: 'verify' }),
      })

      expect(result.lastVerify!.tailOutput).toBe('error: type mismatch\n  at line 42')
    })

    it('caps tailOutput at 4096 bytes using the trailing portion', async () => {
      const bigOutput = 'x'.repeat(8000)
      vi.mocked(Q.getTranscript).mockResolvedValue({
        taskId: 'task-01',
        conversationJson: '',
        verifyOutput: bigOutput,
        bytes: bigOutput.length,
        recordedAt: '2026-08-17T00:00:00.000Z',
      })

      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({ failedPhase: 'verify' }),
      })

      expect(result.lastVerify!.tailOutput!.length).toBe(4096)
    })

    it('falls back to stallDiagnostics when transcript has no verifyOutput', async () => {
      vi.mocked(Q.getTranscript).mockResolvedValue(null)

      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({
          failedPhase: 'verify',
          stallDiagnostics: JSON.stringify({ outputTail: 'stall tail output', exitCode: 1 }),
        }),
      })

      expect(result.lastVerify!.tailOutput).toBe('stall tail output')
      expect(result.lastVerify!.exitCode).toBe(1)
    })

    it('prefers failureReasonCode over failureSignature for signature field', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({
          failedPhase: 'verify',
          failureReasonCode: 'verify:test',
          failureSignature: 'raw-sig',
        }),
      })

      expect(result.lastVerify!.signature).toBe('verify:test')
    })

    it('falls back to failureSignature when failureReasonCode is null', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask({
          failedPhase: 'verify',
          failureReasonCode: null,
          failureSignature: 'raw-sig',
        }),
      })

      expect(result.lastVerify!.signature).toBe('raw-sig')
    })
  })

  // ── diagnostics ───────────────────────────────────────────────────────

  describe('diagnostics', () => {
    it('includes taskId, mergeBase sha, and commitCount', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-42',
        worktreePath: repoDir,
        task: makeTask(),
      })

      expect(result.diagnostics.taskId).toBe('task-42')
      expect(typeof result.diagnostics.mergeBase).toBe('string')
      expect((result.diagnostics.mergeBase as string).length).toBe(40)
      expect(result.diagnostics.commitCount).toBe(0)
    })

    it('includes workflowState when provided', async () => {
      const result = await composeRestartCheckpoint({
        taskId: 'task-01',
        worktreePath: repoDir,
        task: makeTask(),
        workflowState: { step: 'code', runId: 'run-xyz' },
      })

      expect(result.diagnostics.workflowState).toEqual({ step: 'code', runId: 'run-xyz' })
    })
  })
})
