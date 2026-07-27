import { describe, it, expect } from 'vitest'
import {
  WorktreeAheadPayloadSchema,
  WORKTREE_AHEAD_FAILURE_REASON,
  type WorktreeAheadPayload,
} from '../worktree-ahead-payload'

const validPayload: WorktreeAheadPayload = {
  taskId: 'mars-abc123',
  branch: 'task/mars-abc123',
  worktreePath: '/tmp/worktrees/mars-abc123',
  integrationBranch: 'main',
  commitsAhead: [
    { shortSha: 'a1b2c3d', subject: 'feat: add widget' },
    { shortSha: 'e4f5g6h', subject: 'fix: widget tests' },
  ],
  onMainLean: 'not-on-main',
  leaseOwned: false,
  failureReason: WORKTREE_AHEAD_FAILURE_REASON,
}

describe('WorktreeAheadPayloadSchema', () => {
  it('parses a valid blocker-resolution payload', () => {
    const result = WorktreeAheadPayloadSchema.parse(validPayload)
    expect(result.taskId).toBe('mars-abc123')
    expect(result.commitsAhead).toHaveLength(2)
    expect(result.onMainLean).toBe('not-on-main')
    expect(result.leaseOwned).toBe(false)
    expect(result.failureReason).toBe(WORKTREE_AHEAD_FAILURE_REASON)
  })

  it('parses a phase-recovery payload (onMainLean=unknown)', () => {
    const payload = { ...validPayload, onMainLean: 'unknown' as const }
    const result = WorktreeAheadPayloadSchema.parse(payload)
    expect(result.onMainLean).toBe('unknown')
  })

  it('parses a restart-cleanup payload (leaseOwned=true)', () => {
    const payload = { ...validPayload, leaseOwned: true }
    const result = WorktreeAheadPayloadSchema.parse(payload)
    expect(result.leaseOwned).toBe(true)
  })

  it('accepts nullable branch and worktreePath', () => {
    const payload = { ...validPayload, branch: null, worktreePath: null }
    const result = WorktreeAheadPayloadSchema.parse(payload)
    expect(result.branch).toBeNull()
    expect(result.worktreePath).toBeNull()
  })

  it('accepts empty commitsAhead', () => {
    const payload = { ...validPayload, commitsAhead: [] }
    const result = WorktreeAheadPayloadSchema.parse(payload)
    expect(result.commitsAhead).toHaveLength(0)
  })

  it('rejects a wrong failureReason literal', () => {
    const payload = { ...validPayload, failureReason: 'wrong-reason' }
    expect(() => WorktreeAheadPayloadSchema.parse(payload)).toThrow()
  })

  it('rejects an invalid onMainLean value', () => {
    const payload = { ...validPayload, onMainLean: 'maybe' }
    expect(() => WorktreeAheadPayloadSchema.parse(payload)).toThrow()
  })

  it('recipe humanDetail can extract all typed keys', () => {
    const parsed = WorktreeAheadPayloadSchema.parse(validPayload)
    expect(parsed.branch).toBeDefined()
    expect(parsed.worktreePath).toBeDefined()
    expect(parsed.integrationBranch).toBeDefined()
    expect(parsed.commitsAhead).toBeDefined()
    expect(parsed.onMainLean).toBeDefined()
    expect(parsed.leaseOwned).toBeDefined()
  })
})
