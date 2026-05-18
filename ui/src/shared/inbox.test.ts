import { describe, expect, it } from 'bun:test'
import { inboxResponseSchema } from './schemas'

const makeTask = (id: string, status: 'blocked' | 'failed') => ({
  id,
  prompt: `prompt for ${id}`,
  status,
  plan: null,
  branch: null,
  worktreePath: null,
  error: null,
  dropReason: null,
  retryCount: 0,
  blockerTaskId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

const makeDraft = (id: string) => ({
  id,
  goal: `goal for ${id}`,
  story: '',
  technical: '',
  status: 'draft',
  source: 'human' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  acceptanceCount: 0,
})

describe('inboxResponseSchema', () => {
  it('parses an empty inbox with the three required groups', () => {
    const result = inboxResponseSchema.safeParse({ drafts: [], blocked: [], failed: [] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.drafts).toEqual([])
      expect(result.data.blocked).toEqual([])
      expect(result.data.failed).toEqual([])
    }
  })

  it('parses blocked tasks into the blocked group', () => {
    const payload = {
      drafts: [],
      blocked: [makeTask('t-blocked', 'blocked')],
      failed: [],
    }
    const result = inboxResponseSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.blocked).toHaveLength(1)
      expect(result.data.blocked[0].id).toBe('t-blocked')
    }
  })

  it('parses failed tasks into the failed group', () => {
    const payload = {
      drafts: [],
      blocked: [],
      failed: [makeTask('t-failed', 'failed')],
    }
    const result = inboxResponseSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.failed).toHaveLength(1)
      expect(result.data.failed[0].id).toBe('t-failed')
    }
  })

  it('parses draft ideas into the drafts group', () => {
    const payload = {
      drafts: [makeDraft('idea-1')],
      blocked: [],
      failed: [],
    }
    const result = inboxResponseSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.drafts).toHaveLength(1)
      expect(result.data.drafts[0].id).toBe('idea-1')
    }
  })

  it('rejects a payload missing any of the three groups', () => {
    expect(inboxResponseSchema.safeParse({ drafts: [], blocked: [] }).success).toBe(false)
    expect(inboxResponseSchema.safeParse({ drafts: [], failed: [] }).success).toBe(false)
    expect(inboxResponseSchema.safeParse({ blocked: [], failed: [] }).success).toBe(false)
  })
})
