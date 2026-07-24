/**
 * Unit tests for `notice-store.ts` — the entity-less bell-message store
 * (ADR-0079).
 *
 * Tests operate through the public `notice-store` API only, not DB internals —
 * so an internal refactor (column rename, SQL rewrite) leaves these tests
 * unchanged. Each test runs against a fresh temp git repo with its own embedded
 * Postgres, loaded via `vi.resetModules()` + dynamic import so the lazy state
 * client rebinds per repo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// ── Module-level types (used to drive dynamic imports) ────────────────────────

interface NoticeStoreModule {
  initNoticeStore: typeof import('../notice-store').initNoticeStore
  createNotice: typeof import('../notice-store').createNotice
  listOpenNotices: typeof import('../notice-store').listOpenNotices
  ackNotice: typeof import('../notice-store').ackNotice
}

// ── Repo setup ────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-notice-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadNoticeStore = async (repo: string): Promise<NoticeStoreModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = (await import('../notice-store')) as unknown as NoticeStoreModule
  await mod.initNoticeStore()
  return mod
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('notice-store', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('create → list surfaces the notice as open', async () => {
    const { createNotice, listOpenNotices } = await loadNoticeStore(repo)
    const created = await createNotice('the Steward raised the concurrency limit', 'steward')
    expect(created.acknowledgedAt).toBeNull()
    expect(created.source).toBe('steward')

    const open = await listOpenNotices()
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(created.id)
    expect(open[0].body).toBe('the Steward raised the concurrency limit')
  })

  it('lists open notices newest-first', async () => {
    const { createNotice, listOpenNotices } = await loadNoticeStore(repo)
    const first = await createNotice('first', 'operator')
    const second = await createNotice('second', 'operator')
    const third = await createNotice('third', 'operator')

    const open = await listOpenNotices()
    expect(open.map((n) => n.id)).toEqual([third.id, second.id, first.id])
  })

  it('ack removes a notice from the open list', async () => {
    const { createNotice, listOpenNotices, ackNotice } = await loadNoticeStore(repo)
    const a = await createNotice('ack me', 'operator')
    const b = await createNotice('keep me', 'operator')

    const acked = await ackNotice(a.id)
    expect(acked).toBe(true)

    const open = await listOpenNotices()
    expect(open.map((n) => n.id)).toEqual([b.id])
  })

  it('ack is idempotent: a second ack of the same notice returns false', async () => {
    const { createNotice, ackNotice } = await loadNoticeStore(repo)
    const n = await createNotice('once', 'operator')

    expect(await ackNotice(n.id)).toBe(true)
    expect(await ackNotice(n.id)).toBe(false)
  })

  it('ack of a missing id returns false', async () => {
    const { ackNotice } = await loadNoticeStore(repo)
    expect(await ackNotice('nope1234')).toBe(false)
  })
})
