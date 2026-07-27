import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { classifyWorktree, computeDirBytes } from './worktree-reclaim'
import type { Task } from '../queue'

// ---------------------------------------------------------------------------
// Minimal Task fixture — only the fields classifyWorktree cares about
// ---------------------------------------------------------------------------

const makeTask = (status: Task['status']): Task =>
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
    retryCount: 0,
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
    leaseOwner: null,
    leasedAt: null,
    leaseNote: null,
    intent: null,
    originSessionId: null,
  }) as unknown as Task

// ---------------------------------------------------------------------------
// classifyWorktree
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
