import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../queue').enqueueTask
  enqueueFollowUpOnce: typeof import('../queue').enqueueFollowUpOnce
  resolveQueueClient: typeof import('../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-followup-dedup-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

describe('enqueueFollowUpOnce — context-exhausted dedup', () => {
  let repo: string
  let q: QueueModule

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
    q = await import('../queue') as unknown as QueueModule
    await q.migrateQueueSchema()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates exactly one context-exhausted follow-up on first call', async () => {
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })

    const result = await q.enqueueFollowUpOnce(
      origin.id,
      'context-exhausted',
      '## context-exhausted follow-up for task ' + origin.id,
    )

    expect(result.created).toBe(true)
    expect(result.id).toMatch(/^mars-/)

    // Confirm exactly one follow-up row exists with the dedup origin_id
    const c = q.resolveQueueClient()
    const rows = await c.execute({
      sql: `SELECT id, origin_id, status FROM tasks WHERE origin_id = ?`,
      args: [`followup:${origin.id}:context-exhausted`],
    })
    expect(rows.rows).toHaveLength(1)
  })

  it('returns the existing follow-up on a second call (simulates origin restart)', async () => {
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const prompt = '## context-exhausted follow-up for task ' + origin.id

    // First call — creates the follow-up
    const first = await q.enqueueFollowUpOnce(origin.id, 'context-exhausted', prompt)
    expect(first.created).toBe(true)

    // Second call — origin restarted and context-exhausted again
    const second = await q.enqueueFollowUpOnce(origin.id, 'context-exhausted', prompt)
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)

    // Still exactly one follow-up in DB
    const c = q.resolveQueueClient()
    const rows = await c.execute({
      sql: `SELECT id FROM tasks WHERE origin_id = ?`,
      args: [`followup:${origin.id}:context-exhausted`],
    })
    expect(rows.rows).toHaveLength(1)
  })

  it('does not re-create a follow-up even after many restarts', async () => {
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const prompt = '## context-exhausted follow-up for task ' + origin.id

    const results: Array<{ id: string; created: boolean }> = []
    for (let i = 0; i < 5; i++) {
      results.push(await q.enqueueFollowUpOnce(origin.id, 'context-exhausted', prompt))
    }

    // Only the first call creates; all subsequent calls skip
    expect(results[0].created).toBe(true)
    expect(results.slice(1).every((r) => r.created === false)).toBe(true)
    expect(results.slice(1).every((r) => r.id === results[0].id)).toBe(true)

    // Exactly one follow-up in DB
    const c = q.resolveQueueClient()
    const rows = await c.execute({
      sql: `SELECT id FROM tasks WHERE origin_id = ?`,
      args: [`followup:${origin.id}:context-exhausted`],
    })
    expect(rows.rows).toHaveLength(1)
  })
})

describe('enqueueFollowUpOnce — exploration-loop dedup', () => {
  let repo: string
  let q: QueueModule

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
    q = await import('../queue') as unknown as QueueModule
    await q.migrateQueueSchema()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates exactly one exploration-loop follow-up on first call', async () => {
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })

    const result = await q.enqueueFollowUpOnce(
      origin.id,
      'exploration-loop',
      '## exploration-loop follow-up for task ' + origin.id,
    )

    expect(result.created).toBe(true)
    expect(result.id).toMatch(/^mars-/)
  })

  it('returns the existing follow-up on a second call (simulates origin restart)', async () => {
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const prompt = '## exploration-loop follow-up for task ' + origin.id

    // First call — creates the follow-up
    const first = await q.enqueueFollowUpOnce(origin.id, 'exploration-loop', prompt)
    expect(first.created).toBe(true)

    // Second call — origin restarted and hit the ceiling again
    const second = await q.enqueueFollowUpOnce(origin.id, 'exploration-loop', prompt)
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)

    // Still exactly one follow-up in DB
    const c = q.resolveQueueClient()
    const rows = await c.execute({
      sql: `SELECT id FROM tasks WHERE origin_id = ?`,
      args: [`followup:${origin.id}:exploration-loop`],
    })
    expect(rows.rows).toHaveLength(1)
  })
})

describe('enqueueFollowUpOnce — context-exhausted and exploration-loop are independent', () => {
  let repo: string
  let q: QueueModule

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
    q = await import('../queue') as unknown as QueueModule
    await q.migrateQueueSchema()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('treats context-exhausted and exploration-loop as separate dedup keys for the same origin', async () => {
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })

    const ce = await q.enqueueFollowUpOnce(
      origin.id,
      'context-exhausted',
      '## context-exhausted follow-up',
    )
    const el = await q.enqueueFollowUpOnce(
      origin.id,
      'exploration-loop',
      '## exploration-loop follow-up',
    )

    // Both are created and have distinct ids
    expect(ce.created).toBe(true)
    expect(el.created).toBe(true)
    expect(ce.id).not.toBe(el.id)
  })
})

describe('enqueueFollowUpOnce — terminal follow-up allows re-creation', () => {
  let repo: string
  let q: QueueModule

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
    q = await import('../queue') as unknown as QueueModule
    await q.migrateQueueSchema()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('creates a fresh follow-up when the existing one has been resolved (done)', async () => {
    const origin = await q.enqueueTask('origin task', undefined, { skipTriage: true })
    const prompt = '## context-exhausted follow-up for task ' + origin.id

    // First follow-up created
    const first = await q.enqueueFollowUpOnce(origin.id, 'context-exhausted', prompt)
    expect(first.created).toBe(true)

    // Simulate the follow-up being resolved
    const c = q.resolveQueueClient()
    await c.execute({
      sql: `UPDATE tasks SET status = 'done' WHERE id = ?`,
      args: [first.id],
    })

    // Now a fresh follow-up should be allowed
    const second = await q.enqueueFollowUpOnce(origin.id, 'context-exhausted', prompt)
    expect(second.created).toBe(true)
    expect(second.id).not.toBe(first.id)
  })
})
