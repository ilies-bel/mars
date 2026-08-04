/**
 * The sweep's job is restraint. Every test here is about Mars NOT speaking,
 * except the one that proves it can.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../../db.js'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-notice-sweep-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const load = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const chat = await import('../../chat-store.js')
  await chat.initChatStore()
  const { resolveStateClient } = await import('../../../store/state-client.js')
  const { runNoticeSweep } = await import('../sweep.js')
  return { db: resolveStateClient() as DbClient, runNoticeSweep }
}

const withDraft = async (db: DbClient) => {
  await db.execute(
    `INSERT INTO proposals (id, title, status, created_at, updated_at)
     VALUES ('prop-1', 'Rework the merge gate', 'draft', 1, 1)`,
  )
}

describe('runNoticeSweep', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const base = (db: DbClient, post: ReturnType<typeof vi.fn>, level = 'tell') => ({
    client: db,
    repoRoot: repo,
    integrationBranch: 'main',
    listCommits: async () => [],
    post: post as never,
    readAutonomyLevel: () => level,
  })

  it('speaks the one Notice the evidence supports', async () => {
    const { db, runNoticeSweep } = await load(repo)
    await withDraft(db)
    const post = vi.fn().mockResolvedValue({ id: 'n1', delivered: true })

    const result = await runNoticeSweep(base(db, post))

    expect(result.posted).toBe(1)
    expect(post.mock.calls[0]![0]).toMatchObject({
      kind: 'session.idle-proposal',
      payload: { proposalId: 'prop-1' },
      priority: 'routine',
    })
  })

  it('does not run a detector whose lever the operator turned off', async () => {
    const { db, runNoticeSweep } = await load(repo)
    await withDraft(db)
    const post = vi.fn().mockResolvedValue({ id: 'n1', delivered: true })

    const result = await runNoticeSweep(base(db, post, 'off'))

    expect(result.posted).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('stays quiet when a lever cannot be read', async () => {
    const { db, runNoticeSweep } = await load(repo)
    await withDraft(db)
    const post = vi.fn().mockResolvedValue({ id: 'n1', delivered: true })
    const log = vi.fn()

    const result = await runNoticeSweep({
      ...base(db, post),
      log,
      readAutonomyLevel: () => { throw new Error('daemon.json lever is invalid') },
    })

    expect(result.posted).toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain('staying quiet')
  })

  it('says nothing at all when nothing has happened', async () => {
    const { db, runNoticeSweep } = await load(repo)
    const post = vi.fn().mockResolvedValue({ id: 'n1', delivered: true })

    expect((await runNoticeSweep(base(db, post))).posted).toBe(0)
    expect(post).not.toHaveBeenCalled()
  })

  it('keeps going when one delivery fails', async () => {
    const { db, runNoticeSweep } = await load(repo)
    await withDraft(db)
    const post = vi.fn().mockRejectedValue(new Error('database is gone'))
    const log = vi.fn()

    const result = await runNoticeSweep({ ...base(db, post), log })

    expect(result.posted).toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain('delivery failed')
  })
})
