import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { classifyWorktree, computeDirBytes, SAFE_CATEGORIES } from './worktree-reclaim'
import type { WorktreeGitState } from './worktree-reclaim'
import type { Task } from '../queue'

// ---------------------------------------------------------------------------
// Minimal Task fixture — only the fields classifyWorktree cares about
// ---------------------------------------------------------------------------

const makeTask = (
  status: Task['status'],
  overrides?: Partial<Pick<Task, 'leaseOwner'>>,
): Task =>
  ({
    id: 'mars-test-0001',
    prompt: 'test',
    status,
    plan: null,
    branch: null,
    worktreePath: null,
    claudeSessionId: null,
    claudeSessionIds: [],
    error: null,
    author: null,
    dropReason: null,
    failureReason: null,
    failureReasonCode: null,
    recoverySpawnedCount: 0,
    envRestartCount: 0,
    fixForTaskId: null,
    failureSignature: null,
    kind: undefined,
    tags: ['coder'],
    originId: 'mars-test-0001',
    priority: 0,
    failedPhase: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedAtMs: Date.now(),
    spec: null,
    leaseOwner: overrides?.leaseOwner ?? null,
    leasedAt: null,
    leaseNote: null,
    intent: null,
    originSessionId: null,
  }) as unknown as Task

// ---------------------------------------------------------------------------
// classifyWorktree — original categories
// ---------------------------------------------------------------------------

describe('classifyWorktree', () => {
  it('returns absent-task when task is null', () => {
    const result = classifyWorktree({ id: 'mars-abc1', task: null })
    expect(result.category).toBe('absent-task')
    expect(result.reason).toMatch(/no task row/)
  })

  it('returns terminal-clean for a done task', () => {
    const result = classifyWorktree({ id: 'mars-abc1', task: makeTask('done') })
    expect(result.category).toBe('terminal-clean')
    expect(result.reason).toContain('done')
  })

  it('returns terminal-clean for a failed task', () => {
    const result = classifyWorktree({ id: 'mars-abc1', task: makeTask('failed') })
    expect(result.category).toBe('terminal-clean')
    expect(result.reason).toContain('failed')
  })

  it('returns terminal-clean for a dropped task', () => {
    const result = classifyWorktree({ id: 'mars-abc1', task: makeTask('dropped') })
    expect(result.category).toBe('terminal-clean')
    expect(result.reason).toContain('dropped')
  })

  it('returns unknown for a running task', () => {
    const result = classifyWorktree({ id: 'mars-abc1', task: makeTask('running') })
    expect(result.category).toBe('unknown')
    expect(result.reason).toContain('running')
  })

  it('returns unknown for a queued task', () => {
    const result = classifyWorktree({ id: 'mars-abc1', task: makeTask('queued') })
    expect(result.category).toBe('unknown')
  })

  it('returns unknown for a verifying task', () => {
    const result = classifyWorktree({ id: 'mars-abc1', task: makeTask('verifying') })
    expect(result.category).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// classifyWorktree — protection categories
// ---------------------------------------------------------------------------

describe('classifyWorktree — protection categories', () => {
  it('returns protected-dirty when worktree has uncommitted changes', () => {
    const gitState: WorktreeGitState = { dirty: true, ahead: 0 }
    const result = classifyWorktree({
      id: 'mars-abc1',
      task: makeTask('done'),
      gitState,
    })
    expect(result.category).toBe('protected-dirty')
    expect(result.reason).toContain('uncommitted')
  })

  it('returns protected-ahead when branch has commits ahead', () => {
    const gitState: WorktreeGitState = { dirty: false, ahead: 3 }
    const result = classifyWorktree({
      id: 'mars-abc1',
      task: makeTask('done'),
      gitState,
    })
    expect(result.category).toBe('protected-ahead')
    expect(result.reason).toContain('3 commit(s)')
  })

  it('returns protected-leased when worktree has a lease owner', () => {
    const result = classifyWorktree({
      id: 'mars-abc1',
      task: makeTask('running'),
      lease: { owner: 'alice' },
    })
    expect(result.category).toBe('protected-leased')
    expect(result.reason).toContain('alice')
  })

  it('returns protected-awaiting-human for awaiting-human tasks', () => {
    const result = classifyWorktree({
      id: 'mars-abc1',
      task: makeTask('awaiting-human' as Task['status']),
    })
    expect(result.category).toBe('protected-awaiting-human')
  })

  it('returns protected-awaiting-validation for awaiting-validation tasks', () => {
    const result = classifyWorktree({
      id: 'mars-abc1',
      task: makeTask('awaiting-validation' as Task['status']),
    })
    expect(result.category).toBe('protected-awaiting-validation')
  })
})

// ---------------------------------------------------------------------------
// classifyWorktree — precedence
// ---------------------------------------------------------------------------

describe('classifyWorktree — precedence', () => {
  it('awaiting-validation beats leased beats ahead beats dirty', () => {
    const gitState: WorktreeGitState = { dirty: true, ahead: 5 }
    const lease = { owner: 'bob' }

    // awaiting-validation wins over everything
    const r1 = classifyWorktree({
      id: 'x',
      task: makeTask('awaiting-validation' as Task['status'], { leaseOwner: 'bob' }),
      gitState,
      lease,
    })
    expect(r1.category).toBe('protected-awaiting-validation')

    // awaiting-human beats leased/ahead/dirty
    const r2 = classifyWorktree({
      id: 'x',
      task: makeTask('awaiting-human' as Task['status'], { leaseOwner: 'bob' }),
      gitState,
      lease,
    })
    expect(r2.category).toBe('protected-awaiting-human')

    // leased beats ahead/dirty
    const r3 = classifyWorktree({
      id: 'x',
      task: makeTask('running'),
      gitState,
      lease,
    })
    expect(r3.category).toBe('protected-leased')

    // ahead beats dirty
    const r4 = classifyWorktree({
      id: 'x',
      task: makeTask('running'),
      gitState,
    })
    expect(r4.category).toBe('protected-ahead')

    // dirty alone
    const r5 = classifyWorktree({
      id: 'x',
      task: makeTask('running'),
      gitState: { dirty: true, ahead: 0 },
    })
    expect(r5.category).toBe('protected-dirty')
  })
})

// ---------------------------------------------------------------------------
// SAFE_CATEGORIES
// ---------------------------------------------------------------------------

describe('SAFE_CATEGORIES', () => {
  it('contains only absent-task and terminal-clean', () => {
    expect(SAFE_CATEGORIES.has('absent-task')).toBe(true)
    expect(SAFE_CATEGORIES.has('terminal-clean')).toBe(true)
    expect(SAFE_CATEGORIES.has('protected-dirty')).toBe(false)
    expect(SAFE_CATEGORIES.has('protected-ahead')).toBe(false)
    expect(SAFE_CATEGORIES.has('protected-leased')).toBe(false)
    expect(SAFE_CATEGORIES.has('unknown')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeDirBytes
// ---------------------------------------------------------------------------

let tmpDir = ''

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'mars-reclaim-test-'))
})

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

describe('computeDirBytes', () => {
  it('returns 0 for a non-existent path', async () => {
    const result = await computeDirBytes(join(tmpDir, 'does-not-exist'))
    expect(result).toBe(0)
  })

  it('returns 0 for an empty directory', async () => {
    const dir = join(tmpDir, 'empty')
    await mkdir(dir)
    const result = await computeDirBytes(dir)
    expect(result).toBe(0)
  })

  it('sums sizes of flat files', async () => {
    const dir = join(tmpDir, 'flat')
    await mkdir(dir)
    await writeFile(join(dir, 'a.txt'), 'hello')   // 5 bytes
    await writeFile(join(dir, 'b.txt'), 'world!')  // 6 bytes
    const result = await computeDirBytes(dir)
    expect(result).toBe(11)
  })

  it('sums sizes of nested files', async () => {
    const dir = join(tmpDir, 'nested')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'top.txt'), '12345')          // 5 bytes
    await writeFile(join(dir, 'sub', 'deep.txt'), '678')    // 3 bytes
    const result = await computeDirBytes(dir)
    expect(result).toBe(8)
  })
})
